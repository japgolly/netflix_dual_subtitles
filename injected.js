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

  // Parse time helper (HH:MM:SS.mmm or MM:SS.mmm or seconds or ticks)
  function parseTime(timeStr) {
    if (typeof timeStr === 'number') return timeStr / 1000;
    if (!timeStr) return 0;
    
    if (timeStr.endsWith('ms')) return parseFloat(timeStr) / 1000;
    if (timeStr.endsWith('s')) return parseFloat(timeStr);
    if (timeStr.endsWith('t')) return parseFloat(timeStr) / 10000000;

    const parts = timeStr.split(':');
    if (parts.length === 3) {
      const hrs = parseFloat(parts[0]);
      const mins = parseFloat(parts[1]);
      const secs = parseFloat(parts[2].replace(',', '.'));
      return hrs * 3600 + mins * 60 + secs;
    } else if (parts.length === 2) {
      const mins = parseFloat(parts[0]);
      const secs = parseFloat(parts[1].replace(',', '.'));
      return mins * 60 + secs;
    }
    return parseFloat(timeStr) || 0;
  }

  // TTML / DFXP XML Parser
  function parseTTML(xmlText) {
    const cues = [];
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const paragraphs = doc.querySelectorAll('p');
      
      paragraphs.forEach((p) => {
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

        let textHtml = p.innerHTML
          .replace(/<br\b[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .trim();

        if (start < end && textHtml) {
          cues.push({ start, end, text: textHtml });
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
      const events = jsonObj.events || (jsonObj.result && jsonObj.result.timedtext) || [];
      events.forEach((evt) => {
        const start = (evt.start || evt.startTime || 0) / 1000;
        const duration = (evt.duration || evt.dur || 0) / 1000;
        const end = evt.end ? evt.end / 1000 : (start + duration);

        let linesText = '';
        if (evt.lines) {
          linesText = evt.lines.map(l => typeof l === 'string' ? l : (l.text || '')).join('\n');
        } else if (evt.text) {
          linesText = typeof evt.text === 'string' ? evt.text : (evt.text.map(t => t.value || t).join(' '));
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
        const end = parseTime(parts[1].trim().split(' ')[0]);

        i++;
        let cueText = [];
        while (i < lines.length && lines[i].trim() !== '') {
          cueText.push(lines[i].trim());
          i++;
        }
        const text = cueText.join('\n').replace(/<[^>]+>/g, '');
        if (start < end && text) {
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
    } else if (responseText.includes('</tt>') || responseText.includes('<tt') || responseText.includes('<p ')) {
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
           safeGet(() => t.id ? String(t.id) : null) || 
           safeGet(() => t.trackId ? String(t.trackId) : null) || 
           `Track ${index + 1}`;
  }

  function extractTrackId(t, index) {
    if (!t) return `track_${index}`;
    if (typeof t === 'string') return t;

    const id = safeGet(() => typeof t.id === 'string' ? t.id : null) || 
               safeGet(() => typeof t.trackId === 'string' ? t.trackId : null) || 
               safeGet(() => typeof t.bcp47 === 'string' ? t.bcp47 : null);

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

  // Intercept Network Requests (XHR & Fetch)
  function handleInterceptedSubtitles(responseText, url) {
    try {
      const cues = parseSubtitlePayload(responseText, url);
      if (cues && cues.length > 0) {
        const trackInfo = safeGet(() => getCurrentActiveTrackInfo(), { trackId: 'captured_track', bcp47: null });
        const activeTrackId = trackInfo.trackId || pendingTrackId || 'captured_track';
        const activeBcp47 = trackInfo.bcp47 || pendingTrackBcp47 || null;

        log(`Intercepted ${cues.length} cues for trackId: ${activeTrackId}, bcp47: ${activeBcp47}`);

        window.postMessage({
          type: 'NETFLIX_DUAL_SUB_CAPTURED',
          url: String(url || ''),
          trackId: String(activeTrackId),
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
        const responseText = extractResponseText(this);
        if (responseText) {
          handleInterceptedSubtitles(responseText, this._url);
        }
      }
    });
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = async function () {
    const response = await origFetch.apply(this, arguments);
    const url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url ? arguments[0].url : '');
    
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
          const previousTrack = safeGet(() => player.getTimedTextTrack());
          pendingTrackId = targetTrackId;
          pendingTrackBcp47 = safeGet(() => match.bcp47 || match.language || targetTrackId, targetTrackId);
          log('Requesting secondary track load for:', targetTrackId, 'bcp47:', pendingTrackBcp47);
          
          player.setTimedTextTrack(match);
          
          // Switch back to primary after Netflix fetches secondary timedtext
          setTimeout(() => {
            if (previousTrack && previousTrack !== match) {
              player.setTimedTextTrack(previousTrack);
            }
            pendingTrackId = null;
            pendingTrackBcp47 = null;
          }, 1000);
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
    safeGet: safeGet
  };

})();
