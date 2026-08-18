(function () {
  'use strict';
  if (window.__netflixDualSubsInjected) return;
  window.__netflixDualSubsInjected = true;

  const DEBUG = false;
  const log = (...args) => DEBUG && console.log('[Netflix Dual Subtitles]', ...args);
  const logError = (...args) => console.error('[Netflix Dual Subtitles]', ...args);

  log('Main world script initialized');

  let pendingTrackId = null;
  let pendingTrackBcp47 = null;
  let previousPrimaryTrack = null;
  let restoreTrackTimer = null;
  let lastSessionId = null;

  const SUBTITLE_URL_PATTERNS = [/timedtext/i, /ttml/i, /dfxp/i, /vtt/i, /\/\?o=/i];

  function isSubtitleUrl(url) {
    return typeof url === 'string' && SUBTITLE_URL_PATTERNS.some(pattern => pattern.test(url));
  }

  // Safe property evaluation wrapper to guard against internal Netflix XHR getters
  function safeGet(fn, fallback = null) {
    try {
      const val = fn();
      return (val !== undefined && val !== null) ? val : fallback;
    } catch (e) {
      return fallback;
    }
  }

  // Safely extract text content from XMLHttpRequest regardless of responseType
  function extractResponseText(xhr) {
    try {
      if (!xhr.responseType || xhr.responseType === '' || xhr.responseType === 'text') {
        return xhr.responseText || '';
      }
      if (xhr.responseType === 'arraybuffer' && xhr.response) {
        return new TextDecoder('utf-8').decode(xhr.response);
      }
      if (xhr.responseType === 'json' && xhr.response) {
        return typeof xhr.response === 'string' ? xhr.response : JSON.stringify(xhr.response);
      }
      if (xhr.response && typeof xhr.response === 'string') {
        return xhr.response;
      }
    } catch (e) {
      logError('Error extracting response text from XHR:', e);
    }
    return '';
  }

  // Parse time helper (HH:MM:SS.mmm or MM:SS.mmm or seconds or ticks or frames)
  function parseTime(timeStr) {
    if (typeof timeStr === 'number') return timeStr / 1000;
    if (!timeStr) return 0;
    
    const str = String(timeStr).trim();
    if (str.endsWith('ms')) return parseFloat(str) / 1000;
    if (str.endsWith('s')) return parseFloat(str);
    if (str.endsWith('t')) return parseFloat(str) / 10000000;

    const parts = str.split(':');
    if (parts.length === 4) {
      const hrs = parseFloat(parts[0]) || 0;
      const mins = parseFloat(parts[1]) || 0;
      const secs = parseFloat(parts[2]) || 0;
      const sub = parseFloat(parts[3].replace(',', '.')) || 0;
      const subSec = sub > 60 ? sub / 1000 : sub / 30;
      return hrs * 3600 + mins * 60 + secs + subSec;
    } else if (parts.length === 3) {
      const hrs = parseFloat(parts[0]) || 0;
      const mins = parseFloat(parts[1]) || 0;
      const secs = parseFloat(parts[2].replace(',', '.')) || 0;
      return hrs * 3600 + mins * 60 + secs;
    } else if (parts.length === 2) {
      const mins = parseFloat(parts[0]) || 0;
      const secs = parseFloat(parts[1].replace(',', '.')) || 0;
      return mins * 60 + secs;
    }
    return parseFloat(str) || 0;
  }

  function extractNodeText(el) {
    if (!el) return '';
    let text = '';
    const childNodes = el.childNodes;
    if (!childNodes || childNodes.length === 0) {
      return (el.textContent || '').trim();
    }
    for (let i = 0; i < childNodes.length; i++) {
      const node = childNodes[i];
      if (node.nodeType === 1) {
        const tag = (node.localName || node.nodeName || '').toLowerCase();
        if (tag === 'br') {
          text += '\n';
        } else {
          text += extractNodeText(node);
        }
      } else if (node.nodeType === 3) {
        text += node.nodeValue || '';
      }
    }
    return text;
  }

  // TTML / DFXP XML Parser
  function parseTTML(xmlText) {
    const cues = [];
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      let paragraphs = doc.getElementsByTagNameNS ? doc.getElementsByTagNameNS('*', 'p') : [];
      if (!paragraphs || paragraphs.length === 0) {
        paragraphs = doc.querySelectorAll('p, [begin]');
      }
      
      Array.from(paragraphs).forEach((p) => {
        const beginAttr = p.getAttribute('begin');
        const endAttr = p.getAttribute('end');
        const durAttr = p.getAttribute('dur');
        
        let start = parseTime(beginAttr);
        let end = 0;
        if (endAttr) {
          end = parseTime(endAttr);
        } else if (durAttr) {
          end = start + parseTime(durAttr);
        }

        let text = extractNodeText(p).trim();

        if (start < end && text) {
          cues.push({ start, end, text });
        }
      });
    } catch (e) {
      logError('Error parsing TTML:', e);
    }
    return cues;
  }

  // Netflix JSON TimedText Parser
  function parseJSONTimedText(jsonObj) {
    const cues = [];
    try {
      const events = jsonObj.events || (jsonObj.result && jsonObj.result.timedtext) || (Array.isArray(jsonObj) ? jsonObj : []);
      events.forEach((evt) => {
        const start = (evt.tStartMs ?? evt.start ?? evt.startTime ?? evt.tOffsetMs ?? 0) / 1000;
        const duration = (evt.dDurationMs ?? evt.duration ?? evt.dur ?? 0) / 1000;
        const end = evt.end ? evt.end / 1000 : (evt.tEndMs ? evt.tEndMs / 1000 : (start + duration));

        let linesText = '';
        if (evt.segs && Array.isArray(evt.segs)) {
          linesText = evt.segs.map(s => typeof s === 'string' ? s : (s.utf8 || s.text || s.value || '')).join('');
        } else if (evt.lines && Array.isArray(evt.lines)) {
          linesText = evt.lines.map(l => {
            if (typeof l === 'string') return l;
            if (l.segs && Array.isArray(l.segs)) {
              return l.segs.map(s => typeof s === 'string' ? s : (s.utf8 || s.text || '')).join('');
            }
            return l.text || '';
          }).join('\n');
        } else if (evt.text) {
          linesText = typeof evt.text === 'string' ? evt.text : (Array.isArray(evt.text) ? evt.text.map(t => typeof t === 'string' ? t : (t.value || t.utf8 || t.text || '')).join(' ') : (evt.text.value || ''));
        }

        linesText = linesText.replace(/<[^>]+>/g, '').trim();
        if (start < end && linesText) {
          cues.push({ start, end, text: linesText });
        }
      });
    } catch (e) {
      logError('Error parsing JSON Subtitles:', e);
    }
    return cues;
  }

  // WebVTT Parser
  function parseVTT(vttText) {
    const cues = [];
    const lines = vttText.split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();
      if (line.includes('-->')) {
        const parts = line.split('-->');
        const start = parseTime(parts[0].trim());
        const end = parseTime(parts[1].trim().split(/\s+/)[0]);

        i++;
        let cueText = [];
        while (i < lines.length && lines[i].trim() !== '') {
          cueText.push(lines[i].trim());
          i++;
        }
        const text = cueText.join('\n').replace(/<[^>]+>/g, '').trim();
        const isThumbnail = text.includes('#xywh=') || /\.(jpg|png|webp)/i.test(text);
        if (start < end && text && !isThumbnail) {
          cues.push({ start, end, text });
        }
      }
      i++;
    }
    return cues;
  }

  function parseSubtitlePayload(responseText, url) {
    if (typeof responseText !== 'string') return [];

    const trimmed = responseText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const json = JSON.parse(responseText);
        return parseJSONTimedText(json);
      } catch (e) {}
    } else if (responseText.includes('</tt>') || responseText.includes('<tt') || responseText.includes('<p') || responseText.includes('xmlns="http://www.w3.org/ns/ttml"')) {
      return parseTTML(responseText);
    } else if (responseText.includes('WEBVTT') || responseText.includes('-->')) {
      return parseVTT(responseText);
    }
    return [];
  }

  function getNetflixPlayer() {
    return safeGet(() => {
      if (!window.netflix || !window.netflix.appContext || !window.netflix.appContext.state) return null;
      const playerApp = window.netflix.appContext.state.playerApp;
      if (!playerApp || typeof playerApp.getAPI !== 'function') return null;

      const playerAPI = safeGet(() => playerApp.getAPI().videoPlayer);
      if (!playerAPI) return null;

      const sessionIds = safeGet(() => playerAPI.getAllPlayerSessionIds ? playerAPI.getAllPlayerSessionIds() : []);
      if (sessionIds && sessionIds.length > 0) {
        const currentSession = sessionIds[0];
        if (lastSessionId && lastSessionId !== currentSession) {
          log('Detected new player session ID:', currentSession);
          safeGet(() => window.postMessage({ type: 'NETFLIX_DUAL_SUB_EPISODE_RESET' }, '*'));
        }
        lastSessionId = currentSession;
        return safeGet(() => playerAPI.getVideoPlayerBySessionId(currentSession));
      }
      return null;
    });
  }

  function extractTrackLabel(t, index) {
    if (!t) return `Track ${index + 1}`;
    if (typeof t === 'string') return t;
    
    return safeGet(() => t.languageDescription ? String(t.languageDescription) : null) || 
           safeGet(() => t.displayName ? String(t.displayName) : null) || 
           safeGet(() => t.label ? String(t.label) : null) || 
           safeGet(() => t.language ? String(t.language) : null) || 
           safeGet(() => t.name ? String(t.name) : null) || 
           safeGet(() => t.bcp47 ? String(t.bcp47) : null) || 
           safeGet(() => (t.id !== undefined && t.id !== null) ? String(t.id) : null) || 
           safeGet(() => (t.trackId !== undefined && t.trackId !== null) ? String(t.trackId) : null) || 
           `Track ${index + 1}`;
  }

  function extractTrackId(t, index) {
    if (!t) return `track_${index}`;
    if (typeof t === 'string') return t;

    const id = safeGet(() => (t.id !== undefined && t.id !== null) ? String(t.id) : null) || 
               safeGet(() => (t.trackId !== undefined && t.trackId !== null) ? String(t.trackId) : null) || 
               safeGet(() => (t.bcp47 !== undefined && t.bcp47 !== null) ? String(t.bcp47) : null);

    if (id) return id;
    return safeGet(() => extractTrackLabel(t, index), `track_${index}`);
  }

  function getCurrentActiveTrackInfo() {
    if (pendingTrackId) {
      return { 
        trackId: String(pendingTrackId), 
        bcp47: pendingTrackBcp47 ? String(pendingTrackBcp47) : null 
      };
    }

    const player = getNetflixPlayer();
    if (player) {
      const currentTrack = safeGet(() => player.getTimedTextTrack ? player.getTimedTextTrack() : null);
      if (currentTrack) {
        const trackId = safeGet(() => extractTrackId(currentTrack, 0), 'current_track');
        const bcp47 = safeGet(() => currentTrack.bcp47 || currentTrack.language);
        return { 
          trackId: String(trackId), 
          bcp47: bcp47 ? String(bcp47) : null 
        };
      }
    }
    return { trackId: 'current_track', bcp47: null };
  }

  function clearPendingTrack() {
    if (restoreTrackTimer) {
      clearTimeout(restoreTrackTimer);
      restoreTrackTimer = null;
    }
    if (previousPrimaryTrack) {
      const player = getNetflixPlayer();
      if (player && player.setTimedTextTrack) {
        safeGet(() => player.setTimedTextTrack(previousPrimaryTrack));
      }
      previousPrimaryTrack = null;
    }
    pendingTrackId = null;
    pendingTrackBcp47 = null;
  }

  function isLanguageMatch(lang1, lang2) {
    if (!lang1 || !lang2) return false;
    const c1 = String(lang1).toLowerCase().split('-')[0].split('_')[0];
    const c2 = String(lang2).toLowerCase().split('-')[0].split('_')[0];
    return c1 === c2;
  }

  function isJapaneseText(text) {
    if (!text) return false;
    return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3400-\u4DBF]/.test(text);
  }

  function detectSubtitleLanguage(responseText, jsonObj, cues) {
    if (jsonObj) {
      const lang = safeGet(() => jsonObj.bcp47 || jsonObj.language || jsonObj.lang ||
                   (jsonObj.result && (jsonObj.result.bcp47 || jsonObj.result.language)) ||
                   (jsonObj.track && (jsonObj.track.bcp47 || jsonObj.track.language)));
      if (lang && typeof lang === 'string') return lang;
    }

    if (typeof responseText === 'string') {
      const xmlLangMatch = responseText.match(/(?:xml:)?lang=["']([^"']+)["']/i);
      if (xmlLangMatch && xmlLangMatch[1]) {
        return xmlLangMatch[1];
      }
      const vttLangMatch = responseText.match(/^Language:\s*([a-zA-Z0-9_-]+)/im);
      if (vttLangMatch && vttLangMatch[1]) {
        return vttLangMatch[1];
      }
    }

    if (cues && cues.length > 0) {
      const sampleText = cues.slice(0, 20).map(c => c.text).join(' ');
      if (isJapaneseText(sampleText)) {
        return 'ja';
      }
      if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(sampleText)) {
        return 'ko';
      }
      if (/[\u0600-\u06FF]/.test(sampleText)) {
        return 'ar';
      }
      if (/[\u0E00-\u0E7F]/.test(sampleText)) {
        return 'th';
      }
      if (/[\u0400-\u04FF]/.test(sampleText)) {
        return 'ru';
      }
      if (/[\u0370-\u03FF]/.test(sampleText)) {
        return 'el';
      }
      if (/[\u0590-\u05FF]/.test(sampleText)) {
        return 'he';
      }
    }

    return null;
  }

  // Intercept Network Requests (XHR & Fetch)
  function handleInterceptedSubtitles(responseText, url) {
    try {
      let jsonObj = null;
      if (typeof responseText === 'string' && (responseText.trim().startsWith('{') || responseText.trim().startsWith('['))) {
        try { jsonObj = JSON.parse(responseText); } catch (e) {}
      }

      const cues = parseSubtitlePayload(responseText, url);
      if (cues && cues.length > 0) {
        const detectedLang = detectSubtitleLanguage(responseText, jsonObj, cues);
        const player = getNetflixPlayer();
        const timedTextTracks = safeGet(() => player && player.getTimedTextTrackList ? player.getTimedTextTrackList() : [], []);
        const currentPrimary = safeGet(() => player && player.getTimedTextTrack ? player.getTimedTextTrack() : null);

        let activeTrackId = null;
        let activeBcp47 = null;

        const sampleText = cues.slice(0, 20).map(c => c.text).join(' ');
        const hasJapanese = isJapaneseText(sampleText);
        const isPendingJapanese = Boolean(pendingTrackBcp47 && pendingTrackBcp47.toLowerCase().startsWith('ja'));

        // Check if this payload matches our pending track request
        const isPendingMatch = Boolean(pendingTrackId) && (
          (isPendingJapanese && (hasJapanese || isLanguageMatch(detectedLang, 'ja'))) ||
          (!isPendingJapanese && !hasJapanese && (!detectedLang || isLanguageMatch(detectedLang, pendingTrackBcp47)))
        );

        if (pendingTrackId && isPendingMatch) {
          activeTrackId = pendingTrackId;
          activeBcp47 = pendingTrackBcp47 || detectedLang || (hasJapanese ? 'ja' : null);
          log(`Captured requested secondary track: ${activeTrackId} (${activeBcp47}), cues: ${cues.length}`);

          setTimeout(() => {
            clearPendingTrack();
          }, 150);
        } else {
          // In-flight primary or background track payload
          let matchedTrack = null;
          if (detectedLang && timedTextTracks.length > 0) {
            matchedTrack = timedTextTracks.find((t) => 
              isLanguageMatch(safeGet(() => t.bcp47 || t.language), detectedLang)
            );
          }
          if (!matchedTrack && currentPrimary && !pendingTrackId) {
            matchedTrack = currentPrimary;
          }

          if (matchedTrack) {
            const idx = timedTextTracks.indexOf(matchedTrack);
            activeTrackId = extractTrackId(matchedTrack, idx >= 0 ? idx : 0);
            activeBcp47 = safeGet(() => matchedTrack.bcp47 || matchedTrack.language) || detectedLang;
          } else {
            const trackInfo = safeGet(() => getCurrentActiveTrackInfo(), { trackId: 'captured_track', bcp47: null });
            activeTrackId = (previousPrimaryTrack ? extractTrackId(previousPrimaryTrack, 0) : null) || trackInfo.trackId || 'captured_track';
            activeBcp47 = detectedLang || (previousPrimaryTrack ? safeGet(() => previousPrimaryTrack.bcp47 || previousPrimaryTrack.language) : null) || trackInfo.bcp47;
          }

          log(`Captured primary/background track: ${activeTrackId} (${activeBcp47}), cues: ${cues.length}`);
        }

        window.postMessage({
          type: 'NETFLIX_DUAL_SUB_CAPTURED',
          url: String(url || ''),
          trackId: String(activeTrackId || 'captured_track'),
          bcp47: activeBcp47 ? String(activeBcp47) : null,
          cues: cues
        }, '*');
      }
    } catch (err) {
      logError('Subtitle processing error:', err);
    }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      if (isSubtitleUrl(this._url)) {
        if (this.responseType === 'blob' && this.response instanceof Blob) {
          const selfUrl = this._url;
          this.response.text().then(text => {
            if (text) handleInterceptedSubtitles(text, selfUrl);
          }).catch(() => {});
        } else {
          const responseText = extractResponseText(this);
          if (responseText) {
            handleInterceptedSubtitles(responseText, this._url);
          }
        }
      }
    });
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = async function () {
    const response = await origFetch.apply(this, arguments);
    const rawArg = arguments[0];
    const url = typeof rawArg === 'string' ? rawArg : (rawArg && rawArg.url ? rawArg.url : (rawArg && rawArg.href ? rawArg.href : ''));
    
    if (isSubtitleUrl(url)) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        handleInterceptedSubtitles(text, url);
      } catch (err) {}
    }
    return response;
  };

  // Periodic poll to check player status and inform content script
  setInterval(() => {
    const player = getNetflixPlayer();
    if (!player) return;

    try {
      const timedTextTracks = safeGet(() => player.getTimedTextTrackList ? player.getTimedTextTrackList() : [], []);
      const currentTrack = safeGet(() => player.getTimedTextTrack ? player.getTimedTextTrack() : null);

      const tracks = timedTextTracks.map((t, idx) => ({
        id: String(extractTrackId(t, idx)),
        language: safeGet(() => t.language || t.bcp47, 'unk'),
        label: String(extractTrackLabel(t, idx)),
        bcp47: safeGet(() => t.bcp47 || t.language, 'unk'),
        isNone: safeGet(() => t.rawTrack ? (t.rawTrack.isNone || t.rawTrack.trackType === 'OFF') : (t.isOff || false), false),
        raw: null
      }));

      const primaryId = currentTrack ? extractTrackId(currentTrack, 0) : null;

      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_PLAYER_STATE',
        tracks: tracks,
        currentPrimaryTrackId: primaryId ? String(primaryId) : null
      }, '*');
    } catch (err) {}
  }, 1200);

  // Listen for requests from content.js to select secondary track via Netflix player API
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'NETFLIX_DUAL_SUB_FETCH_TRACK') {
      const targetTrackId = event.data.trackId;
      const player = getNetflixPlayer();
      if (!player) return;

      try {
        const timedTextTracks = safeGet(() => player.getTimedTextTrackList ? player.getTimedTextTrackList() : [], []);
        const match = timedTextTracks.find((t, idx) => 
          extractTrackId(t, idx) === targetTrackId || 
          safeGet(() => t.bcp47) === targetTrackId || 
          safeGet(() => t.language) === targetTrackId
        );
        if (match && player.setTimedTextTrack) {
          previousPrimaryTrack = safeGet(() => player.getTimedTextTrack());
          pendingTrackId = targetTrackId;
          pendingTrackBcp47 = safeGet(() => match.bcp47 || match.language || targetTrackId, targetTrackId);
          log('Requesting secondary track load for:', targetTrackId, 'bcp47:', pendingTrackBcp47);
          
          player.setTimedTextTrack(match);
          
          if (restoreTrackTimer) clearTimeout(restoreTrackTimer);
          restoreTrackTimer = setTimeout(() => {
            clearPendingTrack();
          }, 3500);
        }
      } catch (err) {
        logError('Error setting secondary track:', err);
      }
    }
  });

  // Export utilities for testing
  window.__netflixDualSubsInjectedUtils = {
    parseTime: parseTime,
    parseTTML: parseTTML,
    parseJSONTimedText: parseJSONTimedText,
    parseVTT: parseVTT,
    isSubtitleUrl: isSubtitleUrl,
    extractResponseText: extractResponseText,
    safeGet: safeGet,
    isLanguageMatch: isLanguageMatch,
    isJapaneseText: isJapaneseText,
    detectSubtitleLanguage: detectSubtitleLanguage,
    handleInterceptedSubtitles: handleInterceptedSubtitles
  };

})();
