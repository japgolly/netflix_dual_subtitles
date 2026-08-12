(function () {
  'use strict';

  const DEBUG = false;
  const log = (...args) => DEBUG && console.log('[Netflix Dual Subtitles]', ...args);
  const logError = (...args) => console.error('[Netflix Dual Subtitles]', ...args);

  log('Content script loaded');

  // DOM Selectors Registry
  const SELECTORS = {
    playerContainers: [
      '.watch-video',
      '[data-uia="watch-video"]',
      '.videoplayer',
      'body'
    ],
    video: 'video'
  };

  // State & DOM Variables
  const state = {
    enabled: true,
    furigana: true,
    secondaryTrackId: null,
    secondaryLanguageCode: null,
    tracks: [],
    cuesMap: new Map(),
    activeCues: [],
    fontSize: 'medium',
    position: 'bottom',
    textStyle: 'bg',
    currentPrimaryTrackId: null,
    panelVisible: false
  };

  let autoFetchedSecondary = false;
  let currentWatchUrl = typeof window !== 'undefined' ? window.location.href : '';
  let rootEl = null;
  let overlayEl = null;
  let cueBoxEl = null;
  let panelEl = null;
  let triggerBtnEl = null;
  let videoEl = null;
  let animFrameId = null;

  // Helper to compare language codes (e.g. "ja" vs "ja-JP")
  function isLanguageMatch(lang1, lang2) {
    if (!lang1 || !lang2) return false;
    const c1 = lang1.toLowerCase().split('-')[0];
    const c2 = lang2.toLowerCase().split('-')[0];
    return c1 === c2;
  }

  // Inject main world script (injected.js)
  function injectMainWorldScript() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) return;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  injectMainWorldScript();

  // Helper to find the active Netflix player container
  function getPlayerContainer() {
    for (const selector of SELECTORS.playerContainers) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return document.body;
  }

  // Detect Netflix player control bar visibility
  function checkPlayerControlsVisibility() {
    if (!overlayEl) return;

    let isVisible = false;

    // Check 1: Netflix controls container & bottom bar elements
    const controls = document.querySelector('.PlayerControlsNeo__bottom-controls') ||
                     document.querySelector('[data-uia="controls-standard"]') ||
                     document.querySelector('.PlayerControlsNeo__all-controls') || 
                     document.querySelector('.controls');

    if (controls) {
      const style = window.getComputedStyle(controls);
      if (style.opacity !== '0' && style.visibility !== 'hidden' && style.display !== 'none') {
        isVisible = true;
      }
    }

    // Check 2: Player wrapper active class
    if (!isVisible) {
      const watchVideo = getPlayerContainer();
      if (watchVideo && (
        watchVideo.classList.contains('active') || 
        watchVideo.classList.contains('is-active') ||
        watchVideo.classList.contains('controls-showing')
      )) {
        isVisible = true;
      }
    }

    // Check 3: Check if native player-timedtext is shifted up
    if (!isVisible) {
      const nativeTimedText = document.querySelector('.player-timedtext') || document.querySelector('[data-uia="player-timedtext"]');
      if (nativeTimedText) {
        const bottomVal = parseFloat(window.getComputedStyle(nativeTimedText).bottom);
        if (!isNaN(bottomVal) && bottomVal > 80) {
          isVisible = true;
        }
      }
    }

    overlayEl.classList.toggle('controls-visible', isVisible);
  }

  // Reset cues and state for new episode
  function resetEpisodeCues() {
    log('Resetting episode cues for new session / navigation');
    state.cuesMap.clear();
    state.activeCues = [];
    autoFetchedSecondary = false;
    if (cueBoxEl) cueBoxEl.style.display = 'none';
  }

  // Load saved preferences
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(['nds_enabled', 'nds_furigana', 'nds_fontSize', 'nds_position', 'nds_textStyle', 'nds_secondaryTrackId', 'nds_secondaryLanguageCode'], (res) => {
      if (!res) return;
      if (res.nds_enabled !== undefined) state.enabled = res.nds_enabled;
      if (res.nds_furigana !== undefined) state.furigana = res.nds_furigana;
      if (res.nds_fontSize) state.fontSize = res.nds_fontSize;
      if (res.nds_position) state.position = res.nds_position;
      if (res.nds_textStyle) state.textStyle = res.nds_textStyle;
      if (res.nds_secondaryTrackId) state.secondaryTrackId = res.nds_secondaryTrackId;
      if (res.nds_secondaryLanguageCode) state.secondaryLanguageCode = res.nds_secondaryLanguageCode;
      
      updateOverlayStyles();
      checkAndAutoFetchSecondaryTrack();
    });
  }

  function savePreferences() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({
        nds_enabled: state.enabled,
        nds_furigana: state.furigana,
        nds_fontSize: state.fontSize,
        nds_position: state.position,
        nds_textStyle: state.textStyle,
        nds_secondaryTrackId: state.secondaryTrackId,
        nds_secondaryLanguageCode: state.secondaryLanguageCode
      });
    }
  }

  // Auto-fetch saved secondary track when player is ready
  function checkAndAutoFetchSecondaryTrack() {
    if (!state.secondaryTrackId && !state.secondaryLanguageCode) return;
    if (!state.tracks || state.tracks.length === 0) return;

    const baseLang = state.secondaryLanguageCode ? state.secondaryLanguageCode.split('-')[0] : null;

    // Check if we already have cues in memory for the secondary track
    if (baseLang && state.cuesMap.has(baseLang)) {
      autoFetchedSecondary = true;
      return;
    }
    if (state.secondaryLanguageCode && state.cuesMap.has(state.secondaryLanguageCode)) {
      autoFetchedSecondary = true;
      return;
    }
    if (state.secondaryTrackId && state.cuesMap.has(state.secondaryTrackId)) {
      autoFetchedSecondary = true;
      return;
    }

    if (autoFetchedSecondary) return;

    const match = state.tracks.find(t => 
      (state.secondaryLanguageCode && (isLanguageMatch(t.bcp47, state.secondaryLanguageCode) || isLanguageMatch(t.language, state.secondaryLanguageCode))) ||
      t.id === state.secondaryTrackId || 
      t.bcp47 === state.secondaryTrackId || 
      t.language === state.secondaryTrackId ||
      t.label.toLowerCase().includes((state.secondaryLanguageCode || state.secondaryTrackId).toLowerCase())
    );

    if (match) {
      const targetId = match.id;
      autoFetchedSecondary = true;
      log('Auto-requesting saved secondary track on page load / episode transition:', targetId);
      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_FETCH_TRACK',
        trackId: targetId
      }, '*');

      // Retry after 2.5s if cues still haven't arrived
      setTimeout(() => {
        if (baseLang && !state.cuesMap.has(baseLang) && !state.cuesMap.has(targetId)) {
          log('Cues not arrived yet, resetting autoFetchedSecondary for retry');
          autoFetchedSecondary = false;
        }
      }, 2500);
    }
  }

  // Build / Ensure Root Host
  function ensureRootHost() {
    const playerContainer = getPlayerContainer();

    if (!rootEl || !rootEl.isConnected) {
      rootEl = document.getElementById('nds-root');
      if (!rootEl) {
        rootEl = document.createElement('div');
        rootEl.id = 'nds-root';
      }
    }

    if (rootEl.parentNode !== playerContainer) {
      playerContainer.appendChild(rootEl);
    }
  }

  // Create Subtitle Overlay
  function createOverlay() {
    ensureRootHost();

    if (document.getElementById('netflix-dual-sub-overlay')) {
      overlayEl = document.getElementById('netflix-dual-sub-overlay');
      cueBoxEl = overlayEl.querySelector('.nds-cue-box');
      return;
    }

    overlayEl = document.createElement('div');
    overlayEl.id = 'netflix-dual-sub-overlay';
    
    cueBoxEl = document.createElement('div');
    cueBoxEl.className = 'nds-cue-box';
    cueBoxEl.style.display = 'none';

    overlayEl.appendChild(cueBoxEl);
    rootEl.appendChild(overlayEl);

    updateOverlayStyles();
  }

  function updateOverlayStyles() {
    if (!overlayEl) return;

    overlayEl.className = '';
    overlayEl.classList.add(`position-${state.position}`);
    overlayEl.classList.add(`nds-size-${state.fontSize}`);
    overlayEl.classList.add(`nds-style-${state.textStyle}`);
  }

  // Render Subtitles
  function renderSecondaryCues(currentTime) {
    try {
      if (!state.enabled) {
        if (cueBoxEl) cueBoxEl.style.display = 'none';
        return;
      }

      let cues = null;
      const baseLang = state.secondaryLanguageCode ? state.secondaryLanguageCode.split('-')[0] : null;

      if (baseLang && state.cuesMap.has(baseLang)) {
        cues = state.cuesMap.get(baseLang);
      } else if (state.secondaryLanguageCode && state.cuesMap.has(state.secondaryLanguageCode)) {
        cues = state.cuesMap.get(state.secondaryLanguageCode);
      } else if (state.secondaryTrackId && state.cuesMap.has(state.secondaryTrackId)) {
        cues = state.cuesMap.get(state.secondaryTrackId);
      }

      if (!cues || cues.length === 0) {
        if (cueBoxEl) cueBoxEl.style.display = 'none';
        return;
      }

      const matchingCues = cues.filter(c => currentTime >= c.start && currentTime <= c.end);

      if (matchingCues.length > 0) {
        const rawText = matchingCues.map(c => c.text).join('\n');
        if (cueBoxEl) {
          try {
            if (state.furigana && window.NetflixDualSubsFurigana && window.NetflixDualSubsFurigana.isJapanese(rawText)) {
              cueBoxEl.innerHTML = window.NetflixDualSubsFurigana.toFurigana(rawText);
            } else {
              cueBoxEl.innerText = rawText;
            }
          } catch (err) {
            cueBoxEl.innerText = rawText;
          }
          cueBoxEl.style.display = 'inline-block';
        }
      } else {
        if (cueBoxEl) {
          cueBoxEl.style.display = 'none';
        }
      }
    } catch (e) {
      logError('Render error:', e);
    }
  }

  // Video Loop Sync
  function startSyncLoop() {
    if (animFrameId) cancelAnimationFrame(animFrameId);

    function tick() {
      if (!videoEl || !videoEl.isConnected) {
        videoEl = document.querySelector(SELECTORS.video);
      }

      if (videoEl && !videoEl.paused) {
        renderSecondaryCues(videoEl.currentTime);
      }
      animFrameId = requestAnimationFrame(tick);
    }
    tick();
  }

  // Toggle Panel Helper
  function setPanelVisibility(show) {
    state.panelVisible = show === undefined ? !state.panelVisible : show;
    log('Setting panel visibility to:', state.panelVisible);

    if (!panelEl) createUI();
    if (!panelEl) return;

    if (state.panelVisible) {
      panelEl.classList.add('show');
    } else {
      panelEl.classList.remove('show');
    }
  }

  // Language Display Formatting
  let languageNames = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
      languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
    }
  } catch (e) {}

  function formatLanguageLabel(rawLabel, bcp47Code) {
    if (rawLabel && rawLabel !== 'undefined' && !rawLabel.startsWith('undefined') && rawLabel !== 'unk') {
      return rawLabel;
    }

    if (bcp47Code && bcp47Code !== 'undefined' && bcp47Code !== 'unk') {
      try {
        if (languageNames) {
          const cleanCode = bcp47Code.split('-')[0];
          const formatted = languageNames.of(cleanCode);
          if (formatted) return formatted;
        }
      } catch (e) {}
      return bcp47Code.toUpperCase();
    }

    return 'Subtitle Track';
  }

  // Create UI Controls & Panel
  function createUI() {
    ensureRootHost();

    if (document.getElementById('netflix-dual-sub-panel')) {
      panelEl = document.getElementById('netflix-dual-sub-panel');
      return;
    }

    panelEl = document.createElement('div');
    panelEl.id = 'netflix-dual-sub-panel';
    panelEl.innerHTML = `
      <div class="nds-panel-header">
        <div class="nds-panel-title"><span>✦</span> Dual Subtitles</div>
        <button class="nds-close-btn" id="nds-close-panel">✕</button>
      </div>

      <div class="nds-field-group nds-switch-row">
        <span class="nds-label" style="margin:0;">Enable Dual Subtitles</span>
        <label class="nds-toggle">
          <input type="checkbox" id="nds-toggle-enable" ${state.enabled ? 'checked' : ''}>
          <span class="nds-slider"></span>
        </label>
      </div>

      <div class="nds-field-group">
        <label class="nds-label">Secondary Language</label>
        <div class="nds-custom-dropdown" id="nds-custom-dropdown">
          <button type="button" class="nds-dropdown-trigger" id="nds-dropdown-trigger">
            <span id="nds-dropdown-selected-label">-- None (Off) --</span>
            <span class="nds-dropdown-arrow">▾</span>
          </button>
          <div class="nds-dropdown-menu" id="nds-dropdown-menu"></div>
        </div>
      </div>

      <div class="nds-field-group nds-switch-row">
        <span class="nds-label" style="margin:0;">Japanese Furigana (ふりがな)</span>
        <label class="nds-toggle">
          <input type="checkbox" id="nds-toggle-furigana" ${state.furigana ? 'checked' : ''}>
          <span class="nds-slider"></span>
        </label>
      </div>

      <div class="nds-field-group">
        <label class="nds-label">Position</label>
        <div class="nds-btn-group">
          <button class="nds-option-btn ${state.position === 'top' ? 'active' : ''}" data-type="position" data-val="top">Top</button>
          <button class="nds-option-btn ${state.position === 'bottom' ? 'active' : ''}" data-type="position" data-val="bottom">Bottom</button>
        </div>
      </div>

      <div class="nds-field-group">
        <label class="nds-label">Font Size</label>
        <div class="nds-btn-group">
          <button class="nds-option-btn ${state.fontSize === 'small' ? 'active' : ''}" data-type="fontSize" data-val="small">S</button>
          <button class="nds-option-btn ${state.fontSize === 'medium' ? 'active' : ''}" data-type="fontSize" data-val="medium">M</button>
          <button class="nds-option-btn ${state.fontSize === 'large' ? 'active' : ''}" data-type="fontSize" data-val="large">L</button>
          <button class="nds-option-btn ${state.fontSize === 'xlarge' ? 'active' : ''}" data-type="fontSize" data-val="xlarge">XL</button>
        </div>
      </div>

      <div class="nds-field-group">
        <label class="nds-label">Text Style</label>
        <div class="nds-btn-group">
          <button class="nds-option-btn ${state.textStyle === 'bg' ? 'active' : ''}" data-type="textStyle" data-val="bg">Dark Box</button>
          <button class="nds-option-btn ${state.textStyle === 'outline' ? 'active' : ''}" data-type="textStyle" data-val="outline">Gold Outline</button>
        </div>
      </div>
    `;

    rootEl.appendChild(panelEl);

    ['click', 'mousedown', 'pointerdown'].forEach(evtType => {
      panelEl.addEventListener(evtType, (e) => e.stopPropagation());
    });

    const closeBtn = document.getElementById('nds-close-panel');
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        setPanelVisibility(false);
      };
    }
    
    const enableCheckbox = document.getElementById('nds-toggle-enable');
    if (enableCheckbox) {
      enableCheckbox.onchange = (e) => {
        state.enabled = e.target.checked;
        savePreferences();
        if (triggerBtnEl) triggerBtnEl.classList.toggle('active', state.enabled);
      };
    }

    const furiganaCheckbox = document.getElementById('nds-toggle-furigana');
    if (furiganaCheckbox) {
      furiganaCheckbox.onchange = (e) => {
        state.furigana = e.target.checked;
        savePreferences();
      };
    }

    const customDropdown = document.getElementById('nds-custom-dropdown');
    const dropdownTrigger = document.getElementById('nds-dropdown-trigger');
    if (customDropdown && dropdownTrigger) {
      dropdownTrigger.onclick = (e) => {
        e.stopPropagation();
        customDropdown.classList.toggle('open');
      };
      
      window.addEventListener('click', (e) => {
        if (!customDropdown.contains(e.target)) {
          customDropdown.classList.remove('open');
        }
      });
    }

    panelEl.querySelectorAll('.nds-option-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const type = btn.getAttribute('data-type');
        const val = btn.getAttribute('data-val');

        state[type] = val;
        savePreferences();

        btn.parentElement.querySelectorAll('.nds-option-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        updateOverlayStyles();
      };
    });

    populateLanguageSelect();
  }

  function createTriggerButton() {
    ensureRootHost();

    if (document.getElementById('nds-trigger-btn')) return;

    triggerBtnEl = document.createElement('button');
    triggerBtnEl.id = 'nds-trigger-btn';
    triggerBtnEl.type = 'button';
    triggerBtnEl.className = `nds-trigger-btn ${state.enabled ? 'active' : ''}`;
    triggerBtnEl.innerHTML = `<span class="nds-icon">💬</span> Dual Subs`;

    rootEl.appendChild(triggerBtnEl);
  }

  let lastPopulatedTrackSignature = '';

  function selectTrack(trackId, bcp47Code, labelText) {
    state.secondaryTrackId = trackId;
    if (bcp47Code) state.secondaryLanguageCode = bcp47Code;

    const customDropdown = document.getElementById('nds-custom-dropdown');
    if (customDropdown) customDropdown.classList.remove('open');

    autoFetchedSecondary = true;
    savePreferences();
    lastPopulatedTrackSignature = '';
    populateLanguageSelect();

    if (trackId) {
      log('Requesting fetch for secondary trackId:', trackId);
      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_FETCH_TRACK',
        trackId: trackId
      }, '*');
    }
  }

  function populateLanguageSelect() {
    const dropdownMenu = document.getElementById('nds-dropdown-menu');
    const selectedLabelEl = document.getElementById('nds-dropdown-selected-label');
    if (!dropdownMenu || !selectedLabelEl) return;

    const signatureParts = [];
    state.tracks.forEach(t => signatureParts.push(`${t.id}:${t.label}:${t.bcp47}`));
    state.cuesMap.forEach((cues, key) => signatureParts.push(`${key}:${cues.length}`));
    const newSignature = signatureParts.join('|') + `|selected:${state.secondaryTrackId}`;

    if (newSignature === lastPopulatedTrackSignature && dropdownMenu.children.length > 0) {
      return;
    }
    lastPopulatedTrackSignature = newSignature;

    dropdownMenu.innerHTML = '';
    const currentVal = state.secondaryTrackId;
    let selectedLabelText = '-- None (Off) --';

    const noneItem = document.createElement('div');
    noneItem.className = `nds-dropdown-item ${!currentVal ? 'selected' : ''}`;
    noneItem.innerText = '-- None (Off) --';
    noneItem.onclick = (e) => {
      e.stopPropagation();
      selectTrack('', null, '-- None (Off) --');
    };
    dropdownMenu.appendChild(noneItem);

    const addedIds = new Set();

    state.tracks.forEach((t, idx) => {
      if (t.isNone) return;
      const trackId = t.id || `track_${idx}`;
      if (addedIds.has(trackId)) return;
      addedIds.add(trackId);

      const displayLabel = formatLanguageLabel(t.label, t.bcp47 || t.language);
      const isPrimary = (trackId === state.currentPrimaryTrackId);
      const fullLabel = displayLabel + (isPrimary ? ' (Primary)' : '');
      const isSelected = (trackId === currentVal || (state.secondaryLanguageCode && isLanguageMatch(t.bcp47 || t.language, state.secondaryLanguageCode)));

      if (isSelected) {
        selectedLabelText = fullLabel;
      }

      const item = document.createElement('div');
      item.className = `nds-dropdown-item ${isSelected ? 'selected' : ''}`;
      item.innerText = fullLabel;
      item.onclick = (e) => {
        e.stopPropagation();
        selectTrack(trackId, t.bcp47 || t.language, fullLabel);
      };
      dropdownMenu.appendChild(item);
    });

    state.cuesMap.forEach((cues, key) => {
      if (!addedIds.has(key)) {
        addedIds.add(key);
        const fullLabel = `Captured Track (${cues.length} cues)`;
        const isSelected = (key === currentVal);
        if (isSelected) selectedLabelText = fullLabel;

        const item = document.createElement('div');
        item.className = `nds-dropdown-item ${isSelected ? 'selected' : ''}`;
        item.innerText = fullLabel;
        item.onclick = (e) => {
          e.stopPropagation();
          selectTrack(key, null, fullLabel);
        };
        dropdownMenu.appendChild(item);
      }
    });

    selectedLabelEl.innerText = selectedLabelText;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('click', (e) => {
      const targetBtn = e.target.closest('#nds-trigger-btn') || e.target.closest('.nds-trigger-btn');
      if (targetBtn) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        log('Trigger button clicked via global capture handler');
        setPanelVisibility();
      }
    }, true);

    window.addEventListener('pointerdown', (e) => {
      const targetBtn = e.target.closest('#nds-trigger-btn') || e.target.closest('.nds-trigger-btn');
      if (targetBtn) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, true);

    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
        e.preventDefault();
        log('Alt+S shortcut pressed');
        setPanelVisibility();
      }
    });

    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;

      const data = event.data;

      if (data.type === 'NETFLIX_DUAL_SUB_EPISODE_RESET') {
        log('Received episode reset signal from injected.js');
        resetEpisodeCues();
        checkAndAutoFetchSecondaryTrack();
      }

      if (data.type === 'NETFLIX_DUAL_SUB_CAPTURED') {
        log(`Captured ${data.cues.length} cues for trackId: ${data.trackId}, bcp47: ${data.bcp47}`);

        if (data.trackId) state.cuesMap.set(data.trackId, data.cues);
        if (data.bcp47) {
          state.cuesMap.set(data.bcp47, data.cues);
          const base = data.bcp47.split('-')[0];
          state.cuesMap.set(base, data.cues);
        }
        if (data.url) state.cuesMap.set(data.url, data.cues);
        
        populateLanguageSelect();
      }

      if (data.type === 'NETFLIX_DUAL_SUB_PLAYER_STATE') {
        if (data.tracks) {
          state.tracks = data.tracks;
          state.currentPrimaryTrackId = data.currentPrimaryTrackId;
          populateLanguageSelect();
          checkAndAutoFetchSecondaryTrack();
        }
      }
    });

    setInterval(() => {
      if (window.location.href !== currentWatchUrl) {
        currentWatchUrl = window.location.href;
        log('SPA Navigation detected! Resetting episode cues for new URL:', currentWatchUrl);
        resetEpisodeCues();
      }
      createOverlay();
      createUI();
      createTriggerButton();
      checkAndAutoFetchSecondaryTrack();
      checkPlayerControlsVisibility();
    }, 250);

    startSyncLoop();
  }

  // Export utilities for testing
  window.__netflixDualSubsContentUtils = {
    formatLanguageLabel: formatLanguageLabel
  };

})();
