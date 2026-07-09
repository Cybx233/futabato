// content.js — 公众号漫画阅读器 Content Script v2
// Injected into mp.weixin.qq.com/s* pages.

(function () {
  'use strict';

  // ===========================================================================
  // SVG Icon Set
  // ===========================================================================
  var DEBUG = false; // flip to true to enable [ComicReader] logs

  var ICONS = {
    // All icons are uniformly 24x24 viewport, sizes are set via CSS on the button.
    // button left (id="btnArrL") — points ← (go prev)
    leftArrow:  '<svg viewBox="0 0 1024 1024"><path d="M512 68c246 0 444 198 444 444S758 956 512 956 68 758 68 512 266 68 512 68m0-68C229 0 0 229 0 512s229 512 512 512 512-229 512-512S795 0 512 0z" fill="currentColor"/><path d="M376 512l51-48 171-174 51 48-174 174 174 174-51 48-171-174z" fill="currentColor"/></svg>',
    // button right (id="btnArrR") — points → (go next)
    rightArrow: '<svg viewBox="0 0 1024 1024"><path d="M512 68c246 0 444 198 444 444S758 956 512 956 68 758 68 512 266 68 512 68m0-68C229 0 0 229 0 512s229 512 512 512 512-229 512-512S795 0 512 0z" fill="currentColor"/><path d="M649 512l-52-48-170-174L376 338l174 174-174 174 51 48 171-174z" fill="currentColor"/></svg>',
    close:      '<svg viewBox="0 0 1024 1024"><path d="M557 512l260-260c12-12 12-32 0-45s-32-12-45 0L512 467 252 207c-12-12-32-12-45 0s-12 32 0 45l260 260-260 260c-12 12-12 32 0 45s32 12 45 0l260-260 260 260c12 12 32 12 45 0s12-32 0-45z" fill="currentColor"/></svg>',
    offset:     '<svg viewBox="0 0 1024 1024"><path d="M679 735l63 63v-156h51v156l63-63 36 36-125 125-125-125zM128 896h469V256H128v640zm260-51V307h158v538H388zm-51 0H179V307h158v538zM640 128v469h256V128H640zm205 51v367h-154V179h154z" fill="currentColor"/></svg>',
    direction:  '<svg viewBox="0 0 1024 1024"><path d="M3 400c0 6 1 11 3 17 0 0 1 0 1 1 2 4 5 9 8 12l2 2 2 1c3 3 7 5 10 7 1 0 3 0 5 1 3 1 6 2 10 2 1 0 3 1 3 1h929c25 0 44-19 44-44s-19-44-44-44H154l165-165c17-17 17-45 0-62s-45-17-62 0L17 367c-8 8-14 19-14 33zm1013 217c-2-4-5-8-8-12l-1-2-2-1c-3-3-6-5-10-6-1-1-3-2-6-2-3-1-6-1-8-2-3 0-5-1-7 0H47c-25 0-44 19-44 44s19 44 44 44h822l-154 155c-17 17-17 45 0 62 8 9 19 13 31 13s22-4 31-13l228-229c9-8 15-20 15-34 0-5-1-11-3-16z" fill="currentColor"/></svg>',
  };

  // ===========================================================================
  // Configuration
  // ===========================================================================
  var CONFIG = Object.freeze({
    MIN_IMAGE_WIDTH: 400,
    PANORAMA_RATIO: 1.6,
    STRIP_RATIO: 4.0,
    SINGLE_PAGE_BREAKPOINT: 900,
    TAIL_DEGRADE_THRESHOLD: 0.85,
    TAIL_SCAN_COUNT: 5,
    TAIL_MIN_TOTAL: 10,
    PAGE_GAP: 0,
    MAX_IMAGE_HEIGHT_VH: 92,
    BACKGROUND_COLOR: '#FFFFFF',
    DEFAULT_DIRECTION: 'rtl',
    HINT_AUTO_HIDE_MS: 3500,
    IMAGE_LOAD_TIMEOUT_MS: 5000,
    OVERLAY_ROOT_ID: '__comic_reader_root__',
  });

  // ===========================================================================
  // ReaderController
  // ===========================================================================
  var ReaderController = (function () {
    var instance = null;

    function getInstance() {
      if (!instance) instance = new ReaderController();
      return instance;
    }

    function ReaderController() {
      this.active = false;
      this._entering = false;
      this.images = [];
      this.index = 0;
      this.direction = CONFIG.DEFAULT_DIRECTION;
      this.isSingleMode = false;
      this.offsetMode = false;    // insert blank at [0] to shift pair alignment
      this._bottomVisible = false; // bottom-bar toggle on click
      this._originalImages = [];  // saved unfiltered list for offset toggle
      this.originalScrollY = 0;
      this.originalOverflow = '';
      this.overlayEl = null;
      this.shadowRoot = null;
      this._boundKeydown = null;
      this._boundResize = null;
      this._boundWheel = null;
      this._wheelLocked = false;
      this._toastTimer = null;
    }

    ReaderController.prototype.log = function () {
      if (DEBUG) console.log('[ComicReader]', Array.prototype.join.call(arguments, ' '));
    };

    // =========================================================================
    // Public API
    // =========================================================================

    ReaderController.prototype.toggle = function () {
      this.log('toggle called, active=', this.active);
      if (this.active) {
        this.exit();
      } else {
        if (this._entering) {
          this.log('already entering, skip');
          return;
        }
        this._entering = true;
        try {
          this.enter();
        } catch (e) {
          this.log('enter error:', e);
          this._entering = false;
        }
      }
    };

    ReaderController.prototype.enter = function () {
      var self = this;
      if (self.active) { self._entering = false; return; }

      self.log('entering...');

      // 1. Check #js_content exists
      var jsContent = document.querySelector('#js_content');
      if (!jsContent) {
        self.showPageToast('未找到文章内容');
        self._entering = false;
        return;
      }

      // 2. Save scroll state
      self.originalScrollY = window.scrollY;
      self.originalOverflow = document.body.style.overflow;

      // 3. Lock body scroll
      document.body.style.overflow = 'hidden';

      // 4. Show loading overlay
      self.renderLoadingOverlay();

      // 5. Extract & filter images
      var rawImgs = self.extractImages(jsContent);
      self.log('raw images:', rawImgs.length);
      self.images = self.filterImages(rawImgs);
      self.log('filtered images:', self.images.length);

      if (self.images.length === 0) {
        self.log('no images found, abort');
        self.destroy();
        self.showPageToast('未找到漫画图片');
        self._entering = false;
        return;
      }

      // 6. Determine mode and render overlay immediately (don't wait for loads)
      self.isSingleMode = window.innerWidth < CONFIG.SINGLE_PAGE_BREAKPOINT;
      self.index = 0;

      // 6b. Detect WeChat collection prev/next links (before rendering overlay)
      self._detectCollection();

      // 7. Render overlay right away (images will load in progressively)
      self.renderOverlay();
      self.renderPage();
      self.updatePageIndicator();

      // 8. Bind events
      self._boundKeydown = self._handleKeydown.bind(self);
      self._boundResize = self._handleResize.bind(self);
      self._boundWheel = self._handleWheel.bind(self);
      window.addEventListener('keydown', self._boundKeydown);
      window.addEventListener('resize', self._boundResize);
      window.addEventListener('wheel', self._boundWheel, { passive: false });

      // 9. Show hint
      self._showHint();

      self.active = true;
      self._entering = false;
      self.log('overlay rendered, images loading in background');

      // 10. Load images in background and re-filter when done
      self._waitForImagesLoad(function () {
        self.log('images loaded, applying post-filter');
        self._markSpecialImages();
        var before = self.images.length;
        self._postLoadFilter();
        if (self.images.length !== before) {
          self.log('post-filter changed count, re-rendering');
          self.index = 0;
          self.renderPage();
          self.updatePageIndicator();
        }
      });
    };

    ReaderController.prototype.exit = function () {
      this.log('exiting...');
      this.destroy();
      this.active = false;
      this.log('exited');
    };

    // =========================================================================
    // Image extraction & filtering
    // =========================================================================

    ReaderController.prototype.extractImages = function (container) {
      var allImgs = container.querySelectorAll('img');
      var results = [];

      for (var i = 0; i < allImgs.length; i++) {
        var img = allImgs[i];
        var url = this._resolveUrl(img);
        if (!url) continue;

        var dataW = parseInt(img.dataset.w) || 0;
        var isGif = url.indexOf('wx_fmt=gif') !== -1;

        results.push({
          url: url,
          dataW: dataW,
          isGif: isGif,
          originalImg: img,
          naturalW: img.naturalWidth || 0,
          naturalH: img.naturalHeight || 0,
          isPanorama: false,
          isStrip: false,
          loadFailed: false,
        });
      }

      return results;
    };

    ReaderController.prototype._resolveUrl = function (img) {
      var src = img.dataset.src || img.src || '';
      if (!src) return null;
      if (src.indexOf('data:image/svg+xml') === 0 || src.indexOf('data:') === 0) return null;
      if (src.indexOf('mmbiz.qpic.cn') === -1) return null;
      return src;
    };

    ReaderController.prototype.filterImages = function (rawImgs) {
      var filtered = [];
      for (var i = 0; i < rawImgs.length; i++) {
        // data-w may be missing on older articles; only filter when present and too small
        if (rawImgs[i].dataW > 0 && rawImgs[i].dataW < CONFIG.MIN_IMAGE_WIDTH) {
          continue;
        }
        filtered.push(rawImgs[i]);
      }
      if (filtered.length >= CONFIG.TAIL_MIN_TOTAL) {
        filtered = this._applyTailDetection(filtered);
      }
      return filtered;
    };

    ReaderController.prototype._applyTailDetection = function (imgs) {
      if (imgs.length < CONFIG.TAIL_MIN_TOTAL) return imgs;

      var mainCount = Math.floor(imgs.length * 0.8);
      var widths = [];
      for (var i = 0; i < mainCount; i++) {
        widths.push(imgs[i].dataW);
      }
      widths.sort(function (a, b) { return a - b; });
      var medianW = widths[Math.floor(widths.length / 2)];

      var tailStart = Math.max(mainCount, imgs.length - CONFIG.TAIL_SCAN_COUNT);
      var threshold = medianW * CONFIG.TAIL_DEGRADE_THRESHOLD;

      var result = imgs.slice(0, tailStart);
      for (var j = tailStart; j < imgs.length; j++) {
        if (imgs[j].dataW < threshold && (medianW - imgs[j].dataW) > 100) {
          continue; // exclude
        }
        result.push(imgs[j]);
      }
      return result;
    };

    // =========================================================================
    // Image loading (callback-based)
    // =========================================================================

    ReaderController.prototype._waitForImagesLoad = function (callback) {
      var self = this;
      var pending = self.images.length;

      if (pending === 0) { callback(); return; }

      for (var i = 0; i < self.images.length; i++) {
        (function (imgData) {
          var domImg = imgData.originalImg;

          if (domImg && domImg.naturalWidth > 1) {
            imgData.naturalW = domImg.naturalWidth;
            imgData.naturalH = domImg.naturalHeight;
            pending--;
            if (pending === 0) callback();
            return;
          }

          // Activate lazy loading
          if (domImg && domImg.src !== imgData.url) {
            domImg.src = imgData.url;
          }

          var done = false;
          var timer = setTimeout(function () {
            if (!done) {
              done = true;
              imgData.loadFailed = true;
              pending--;
              if (pending === 0) callback();
            }
          }, CONFIG.IMAGE_LOAD_TIMEOUT_MS);

          var onLoad = function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            imgData.naturalW = domImg.naturalWidth;
            imgData.naturalH = domImg.naturalHeight;
            pending--;
            if (pending === 0) callback();
          };

          var onError = function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            imgData.loadFailed = true;
            pending--;
            if (pending === 0) callback();
          };

          if (domImg) {
            domImg.addEventListener('load', onLoad, { once: true });
            domImg.addEventListener('error', onError, { once: true });
            // Re-check in case image already loaded synchronously
            if (domImg.complete) onLoad();
          } else {
            // No DOM img to load — keep dataW info, move on
            pending--;
            if (pending === 0) callback();
          }
        })(self.images[i]);
      }
    };

    ReaderController.prototype._markSpecialImages = function () {
      for (var i = 0; i < this.images.length; i++) {
        var img = this.images[i];
        if (img.loadFailed || img.naturalW <= 1 || img.naturalH <= 1) continue;
        var ratio = img.naturalW / img.naturalH;
        if (ratio > CONFIG.PANORAMA_RATIO) img.isPanorama = true;
        if ((img.naturalH / img.naturalW) > CONFIG.STRIP_RATIO) img.isStrip = true;
      }
    };

    // Second-pass filter: runs after images load (have naturalW/naturalH).
    // Filters out images that don't look like comic pages.
    ReaderController.prototype._postLoadFilter = function () {
      var MIN_HEIGHT = 300;           // too short → not a comic page
      var MIN_PORTRAIT_RATIO = 0.6;   // h/w below this → too landscape (banner/header)

      var filtered = [];
      for (var i = 0; i < this.images.length; i++) {
        var img = this.images[i];
        // Skip filter if image failed to load — keep it
        if (img.loadFailed || img.naturalW <= 1 || img.naturalH <= 1) {
          filtered.push(img);
          continue;
        }
        // Too short to be a comic page
        if (img.naturalH < MIN_HEIGHT) {
          continue;
        }
        // Too landscape — banners/headers, not comic pages
        var hwRatio = img.naturalH / img.naturalW;
        if (hwRatio < MIN_PORTRAIT_RATIO) {
          continue;
        }
        filtered.push(img);
      }
      this.log('post-load filter: ' + this.images.length + ' -> ' + filtered.length);
      this.images = filtered;
    };

    // =========================================================================
    // Navigation (direction-aware)
    // =========================================================================

    ReaderController.prototype._step = function () {
      return this.isSingleMode ? 1 : 2;
    };

    ReaderController.prototype.nextPage = function () {
      var step = this._step();
      var maxIndex = this.isSingleMode
        ? this.images.length - 1
        : this.images.length - (this.images.length % 2 === 0 ? 2 : 1);

      if (this.index >= maxIndex) {
        this.showToast('已读完');
        return;
      }
      this.index = Math.min(this.index + step, maxIndex);
      // RTL: next = read forward = content moves right→left, slide from right
      // LTR: next = read forward = content moves left→right, slide from left
      var slide = this.direction === 'rtl' ? 1 : -1;
      this.renderPage(slide);
      this.updatePageIndicator();
    };

    ReaderController.prototype.prevPage = function () {
      var step = this._step();
      if (this.index <= 0) {
        this.showToast('已是第一页');
        return;
      }
      this.index = Math.max(this.index - step, 0);
      // RTL: prev = go back = content moves left→right, slide from left
      // LTR: prev = go back = content moves right→left, slide from right
      var slide = this.direction === 'rtl' ? -1 : 1;
      this.renderPage(slide);
      this.updatePageIndicator();
    };

    ReaderController.prototype._handleClick = function (clientX, windowWidth) {
      var isLeft = clientX < windowWidth / 2;
      if (this.direction === 'rtl') {
        isLeft ? this.nextPage() : this.prevPage();
      } else {
        isLeft ? this.prevPage() : this.nextPage();
      }
    };

    ReaderController.prototype._handleKeydown = function (e) {
      if (e.key === 'Escape') { this.exit(); return; }

      if (this.direction === 'rtl') {
        if (e.key === 'ArrowLeft') this.nextPage();
        else if (e.key === 'ArrowRight') this.prevPage();
      } else {
        if (e.key === 'ArrowLeft') this.prevPage();
        else if (e.key === 'ArrowRight') this.nextPage();
      }

      e.preventDefault();
      e.stopPropagation();
    };

    ReaderController.prototype._handleWheel = function (e) {
      // Ignore tiny scrolls (trackpad jitter)
      if (Math.abs(e.deltaY) < 10) return;

      // Animation lock: if a page-turn animation is in progress, ignore further
      // wheel events until it completes. This gives instant feedback on each
      // deliberate wheel tick while preventing multi-page flips from momentum.
      if (this._wheelLocked) return;
      this._wheelLocked = true;

      if (e.deltaY > 0) {
        this.nextPage();
      } else {
        this.prevPage();
      }

      // Unlock after animation finishes (~180ms crossfade + 20ms buffer)
      var self = this;
      setTimeout(function () { self._wheelLocked = false; }, 200);

      e.preventDefault();
      e.stopPropagation();
    };

    ReaderController.prototype._detectCollection = function () {
      this.collectionPrev = null;
      this.collectionNext = null;

      // WeChat uses <span role="button"> for album navigation, NOT <a> tags.
      // DOM structure (from real page):
      //   .album_read_bd > .album_read_nav_prev (span) / .album_read_nav_next (span)
      //     > .album_read_nav_inner > .album_read_nav_btn + .album_read_nav_title
      var prevBtn = document.querySelector('.album_read_nav_prev');
      var nextBtn = document.querySelector('.album_read_nav_next');

      if (prevBtn) {
        var titleEl = prevBtn.querySelector('.album_read_nav_title_inner');
        this.collectionPrev = {
          element: prevBtn,
          title: titleEl ? titleEl.textContent.trim() : ''
        };
      }
      if (nextBtn) {
        var titleEl = nextBtn.querySelector('.album_read_nav_title_inner');
        this.collectionNext = {
          element: nextBtn,
          title: titleEl ? titleEl.textContent.trim() : ''
        };
      }
    };

    ReaderController.prototype._toggleBars = function () {
      this._barsVisible = !this._barsVisible;
      var topBar = this.shadowRoot ? this.shadowRoot.getElementById('topBar') : null;
      var bottomBar = this.shadowRoot ? this.shadowRoot.getElementById('bottomBar') : null;
      if (topBar) topBar.classList.toggle('top-visible', this._barsVisible);
      if (bottomBar) bottomBar.classList.toggle('bottom-visible', this._barsVisible);
    };

    ReaderController.prototype.toggleDirection = function () {
      this.direction = (this.direction === 'rtl') ? 'ltr' : 'rtl';
      this.renderPage();
      this.updatePageIndicator();
      this._updateCollectionButtons();
      // Update direction button text and title
      if (this.shadowRoot) {
        var btnDir = this.shadowRoot.getElementById('btnDir');
        if (btnDir) {
          var newLabel = this.direction === 'rtl' ? '日漫' : '欧美';
          btnDir.textContent = newLabel;
          btnDir.title = '切换阅读方向 (当前: ' + newLabel + ')';
        }
      }
    };

    ReaderController.prototype.toggleOffset = function () {
      this.offsetMode = !this.offsetMode;
      var self = this;

      if (this.offsetMode) {
        this._originalImages = this.images.slice();
        var blank = { url: '', dataW: 0, isGif: false, originalImg: null,
          naturalW: 0, naturalH: 0, isPanorama: false, isStrip: false,
          loadFailed: false, _blank: true };
        this.images = [blank].concat(this.images);
      } else {
        this.images = this._originalImages.slice();
        this._originalImages = [];
      }

      this.index = 0;
      this.renderPage();
      this.updatePageIndicator();
      this._updateOffsetButton();
    };

    ReaderController.prototype._updateOffsetButton = function () {
      if (!this.shadowRoot) return;
      var btn = this.shadowRoot.getElementById('btnOffset');
      if (btn) {
        if (this.offsetMode) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      }
    };

    ReaderController.prototype._handleResize = function () {
      var wasSingle = this.isSingleMode;
      this.isSingleMode = window.innerWidth < CONFIG.SINGLE_PAGE_BREAKPOINT;

      if (wasSingle !== this.isSingleMode) {
        if (!wasSingle && !this.isSingleMode) {
          // was single, still not single — no change needed
        } else if (wasSingle && this.isSingleMode) {
          // was not single, now single — keep index
        } else {
          // single → double: align index to even
          this.index = Math.floor(this.index / 2) * 2;
        }
        this.renderPage();
        this.updatePageIndicator();
      }
    };

    // =========================================================================
    // UI Rendering
    // =========================================================================

    ReaderController.prototype.renderLoadingOverlay = function () {
      var el = document.createElement('div');
      el.id = CONFIG.OVERLAY_ROOT_ID;
      el.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:' + CONFIG.BACKGROUND_COLOR + ';' +
        'display:flex;align-items:center;justify-content:center;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
      el.innerHTML =
        '<div style="text-align:center;color:#aaa;font-size:14px;">' +
          '<div style="display:flex;gap:6px;justify-content:center;margin-bottom:12px;">' +
            '<div style="width:8px;height:8px;border-radius:50%;background:#ccc;animation:cr-bounce 0.6s infinite alternate;"></div>' +
            '<div style="width:8px;height:8px;border-radius:50%;background:#ccc;animation:cr-bounce 0.6s infinite alternate;animation-delay:0.2s;"></div>' +
            '<div style="width:8px;height:8px;border-radius:50%;background:#ccc;animation:cr-bounce 0.6s infinite alternate;animation-delay:0.4s;"></div>' +
          '</div>' +
          '加载中...' +
        '</div>' +
        '<style>@keyframes cr-bounce{from{transform:translateY(0);opacity:0.4}to{transform:translateY(-8px);opacity:1}}</style>';
      document.body.appendChild(el);
      this.overlayEl = el;
    };

    ReaderController.prototype.renderOverlay = function () {
      var self = this;

      // Remove loading overlay
      if (self.overlayEl && self.overlayEl.parentNode) {
        self.overlayEl.parentNode.removeChild(self.overlayEl);
      }

      self.overlayEl = document.createElement('div');
      self.overlayEl.id = CONFIG.OVERLAY_ROOT_ID;
      document.body.appendChild(self.overlayEl);

      self.shadowRoot = self.overlayEl.attachShadow({ mode: 'closed' });

      // Inject styles
      var styleEl = document.createElement('style');
      styleEl.textContent = self._getCSS();
      self.shadowRoot.appendChild(styleEl);

      // Build DOM
      var dirLabel = self.direction === 'rtl' ? '日漫' : '欧美';
      var dirTitle = self.direction === 'rtl' ? '日漫' : '欧美';
      var titleSafe = self._escapeHtml(document.title || '公众号文章');

      var html =
        '<div class="reader-overlay" id="readerOverlay">' +
          // Top bar: close(left) | title(center) | tools(right)
          '<div class="top-bar" id="topBar">' +
            '<div class="top-bar-left">' +
              '<button class="top-bar-btn" id="btnClose" title="关闭阅读模式 (Esc)">← 返回</button>' +
            '</div>' +
            '<span class="top-bar-title" title="' + titleSafe + '">' + titleSafe + '</span>' +
            '<div class="top-bar-right">' +
              '<button class="top-bar-btn" id="btnOffset" title="插入空白首页（跨页对齐偏移）">奇偶切换</button>' +
              '<button class="top-bar-btn direction-btn" id="btnDir" title="切换阅读方向 (当前: ' + dirTitle + ')">' + dirLabel + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="strip-warning" id="stripWarn" style="display:none;">' +
            '⚠ 部分图片可能不适合横向分页模式' +
            '<button class="close-warn-btn" id="btnWarnClose">' + ICONS.close + '</button>' +
          '</div>' +
          // Main reading stage — the spread is the star
          '<div class="reading-stage">' +
            '<div class="viewport">' +
              '<div class="click-zone left" id="zoneL"></div>' +
              '<div class="click-zone right" id="zoneR"></div>' +
              '<div class="spread-container" id="pagesCt"></div>' +
            '</div>' +
            '<button class="arrow-btn left" id="btnArrL">' + ICONS.leftArrow + '</button>' +
            '<button class="arrow-btn right" id="btnArrR">' + ICONS.rightArrow + '</button>' +
          '</div>' +
          // Bottom bar — hidden by default, toggle on click
          '<div class="bottom-bar" id="bottomBar">' +
            '<div class="bottom-bar-row">' +
              '<div class="progress-track" id="progressTrack">' +
                '<div class="progress-fill" id="progressFill"></div>' +
              '</div>' +
            '</div>' +
            '<div class="bottom-bar-row bottom-bar-meta">' +
              '<a class="collection-nav-btn" id="collectionBtnL" style="display:none;"></a>' +
              '<span class="page-indicator" id="pageInd"></span>' +
              '<a class="collection-nav-btn" id="collectionBtnR" style="display:none;"></a>' +
            '</div>' +
          '</div>' +
          '<div class="toast" id="toast"></div>' +
          '<div class="hint-overlay" id="hint">' +
            '<span class="hint-arrow">←</span>' +
            '<span>点击两侧翻页</span>' +
            '<span class="hint-arrow">→</span>' +
            '<span style="opacity:0.6;">Esc 退出</span>' +
          '</div>' +
        '</div>';

      // insertAdjacentHTML doesn't work on ShadowRoot — use temp container
      var temp = document.createElement('div');
      temp.innerHTML = html;
      while (temp.firstChild) {
        self.shadowRoot.appendChild(temp.firstChild);
      }

      // Bind UI events
      var root = self.shadowRoot;
      root.getElementById('btnClose').addEventListener('click', function () { self.exit(); });
      root.getElementById('btnDir').addEventListener('click', function () { self.toggleDirection(); });
      root.getElementById('btnOffset').addEventListener('click', function () { self.toggleOffset(); });
      self._updateOffsetButton();

      // Toggle bottom bar visibility on click anywhere in the reading stage
      var overlay = root.getElementById('readerOverlay');
      if (overlay) {
        overlay.addEventListener('click', function (e) {
          // Don't toggle when clicking nav arrows, top-bar buttons, or collection nav
          if (e.target.closest('.arrow-btn') || e.target.closest('.top-bar-btn') || e.target.closest('.click-zone') || e.target.closest('.collection-nav-btn')) return;
          self._toggleBars();
        });
      }
      root.getElementById('btnArrL').addEventListener('click', function () {
        self.direction === 'rtl' ? self.nextPage() : self.prevPage();
      });
      root.getElementById('btnArrR').addEventListener('click', function () {
        self.direction === 'rtl' ? self.prevPage() : self.nextPage();
      });
      root.getElementById('zoneL').addEventListener('click', function (e) {
        self._handleClick(e.clientX, window.innerWidth);
      });
      root.getElementById('zoneR').addEventListener('click', function (e) {
        self._handleClick(e.clientX, window.innerWidth);
      });
      root.getElementById('btnWarnClose').addEventListener('click', function () {
        root.getElementById('stripWarn').style.display = 'none';
      });

      // Collection prev/next nav buttons — direction-aware placement
      self._updateCollectionButtons();

      // Bind collection nav via the helper method (re-binds on direction toggle)
      root.getElementById('collectionBtnL').addEventListener('click', makeNavHandler('L'));
      root.getElementById('collectionBtnR').addEventListener('click', makeNavHandler('R'));
    };

    // Helper: create a click handler for collection nav buttons that references
    // the current collection data at click time (not at bind time).
    function makeNavHandler(side) {
      return function (e) {
        e.stopPropagation();
        var info = this._colNavData && this._colNavData[side];
        if (info && info.element) info.element.click();
      };
    }

    ReaderController.prototype._updateCollectionButtons = function () {
      if (!this.shadowRoot) return;
      var btnL = this.shadowRoot.getElementById('collectionBtnL');
      var btnR = this.shadowRoot.getElementById('collectionBtnR');
      if (!btnL || !btnR) return;

      // Clear
      btnL.style.display = 'none'; btnL.textContent = '';
      btnR.style.display = 'none'; btnR.textContent = '';
      this._colNavData = { L: null, R: null };

      if (this.direction === 'rtl') {
        // RTL: next on the left, prev on the right
        if (this.collectionNext) {
          btnL.style.display = '';
          btnL.textContent = '下一篇';
          btnL.title = '下一篇' + (this.collectionNext.title ? '：' + this.collectionNext.title : '');
          this._colNavData.L = this.collectionNext;
        }
        if (this.collectionPrev) {
          btnR.style.display = '';
          btnR.textContent = '上一篇';
          btnR.title = '上一篇' + (this.collectionPrev.title ? '：' + this.collectionPrev.title : '');
          this._colNavData.R = this.collectionPrev;
        }
      } else {
        // LTR: prev on the left, next on the right
        if (this.collectionPrev) {
          btnL.style.display = '';
          btnL.textContent = '上一篇';
          btnL.title = '上一篇' + (this.collectionPrev.title ? '：' + this.collectionPrev.title : '');
          this._colNavData.L = this.collectionPrev;
        }
        if (this.collectionNext) {
          btnR.style.display = '';
          btnR.textContent = '下一篇';
          btnR.title = '下一篇' + (this.collectionNext.title ? '：' + this.collectionNext.title : '');
          this._colNavData.R = this.collectionNext;
        }
      }
    };

    ReaderController.prototype.renderPage = function (direction) {
      var container = this.shadowRoot ? this.shadowRoot.getElementById('pagesCt') : null;
      if (!container) return;

      // Helper: fill container with current pages
      var self = this;
      var fillPages = function () {
        container.innerHTML = '';
        var maxIdx = self.isSingleMode
          ? self.images.length - 1
          : Math.max(0, self.images.length - (self.images.length % 2 === 0 ? 2 : 1));
        if (self.index > maxIdx) self.index = maxIdx;

        if (self.isSingleMode) {
          var img = self.images[self.index];
          if (img) container.appendChild(self._createPageWrapper(img));
        } else {
          var leftImg, rightImg;
          if (self.direction === 'rtl') {
            rightImg = self.images[self.index];
            leftImg = self.images[self.index + 1];
          } else {
            leftImg = self.images[self.index];
            rightImg = self.images[self.index + 1];
          }
          container.appendChild(leftImg ? self._createPageWrapper(leftImg) : self._createEmptyPage());
          container.appendChild(rightImg ? self._createPageWrapper(rightImg) : self._createEmptyPage());
        }
      };

      var slideDir = direction || 0;
      if (slideDir !== 0) {
        // Quick crossfade with subtle directional drift — clean and snappy
        var offset = (slideDir > 0 ? 16 : -16) + 'px';
        container.style.transition = 'none';
        container.style.transform = 'translateX(' + offset + ')';
        container.style.opacity = '0.3';

        requestAnimationFrame(function () {
          fillPages();
          container.style.transform = 'translateX(' + (slideDir > 0 ? '-12' : '12') + 'px)';
          requestAnimationFrame(function () {
            container.style.transition = 'transform 0.18s ease-out, opacity 0.15s ease';
            container.style.transform = 'translateX(0)';
            container.style.opacity = '1';
          });
        });
      } else {
        fillPages();
      }

      // Update direction button
      var dirBtn = this.shadowRoot.getElementById('btnDir');
      if (dirBtn) {
        dirBtn.title = '切换阅读方向 (当前: ' + (this.direction === 'rtl' ? '日漫' : '欧美') + ')';
      }

      this._checkStripWarning();
    };

    ReaderController.prototype._createPageWrapper = function (imgData) {
      var self = this;
      var wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';

      // Blank placeholder (offset mode)
      if (imgData._blank) {
        wrapper.style.background = 'transparent';
        return wrapper;
      }
      if (imgData.isPanorama) wrapper.classList.add('panorama');

      if (imgData.loadFailed) {
        wrapper.classList.add('error-state');
        wrapper.innerHTML = '<span>该页加载失败</span><button class="retry-btn">点击重试</button>';
        wrapper.querySelector('.retry-btn').addEventListener('click', function (ev) {
          ev.stopPropagation();
          self._retryLoad(imgData, wrapper);
        });
        return wrapper;
      }

      var imgEl = document.createElement('img');
      imgEl.src = imgData.url;
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.loading = imgData.isGif ? 'lazy' : 'eager';
      imgEl.alt = '';

      imgEl.addEventListener('error', function () {
        wrapper.classList.add('error-state');
        wrapper.innerHTML = '<span>该页加载失败</span><button class="retry-btn">点击重试</button>';
        wrapper.querySelector('.retry-btn').addEventListener('click', function (ev) {
          ev.stopPropagation();
          self._retryLoad(imgData, wrapper);
        });
      });

      wrapper.appendChild(imgEl);
      return wrapper;
    };

    ReaderController.prototype._createEmptyPage = function () {
      var wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.style.background = 'transparent';
      return wrapper;
    };

    ReaderController.prototype._retryLoad = function (imgData, wrapper) {
      var self = this;
      imgData.loadFailed = false;
      wrapper.className = 'page-wrapper';
      if (imgData.isPanorama) wrapper.classList.add('panorama');
      wrapper.innerHTML = '';

      var imgEl = document.createElement('img');
      imgEl.src = imgData.url + (imgData.url.indexOf('?') !== -1 ? '&' : '?') + '_t=' + Date.now();
      imgEl.referrerPolicy = 'no-referrer';
      imgEl.loading = imgData.isGif ? 'lazy' : 'eager';
      imgEl.alt = '';

      imgEl.addEventListener('error', function () {
        wrapper.classList.add('error-state');
        wrapper.innerHTML = '<span>该页加载失败</span><button class="retry-btn">点击重试</button>';
        wrapper.querySelector('.retry-btn').addEventListener('click', function (ev) {
          ev.stopPropagation();
          self._retryLoad(imgData, wrapper);
        });
      });

      wrapper.appendChild(imgEl);
    };

    ReaderController.prototype.updatePageIndicator = function () {
      var indicator = this.shadowRoot ? this.shadowRoot.getElementById('pageInd') : null;
      if (!indicator) return;

      var totalPages = this.images.length;
      var step = this._step();
      var totalGroups = this.isSingleMode ? totalPages : Math.ceil(totalPages / 2);
      var currentGroup = this.isSingleMode ? (this.index + 1) : (Math.floor(this.index / 2) + 1);

      indicator.textContent = currentGroup + ' / ' + totalGroups;

      // Update progress bar (direction-aware)
      var track = this.shadowRoot.getElementById('progressTrack');
      var fill = this.shadowRoot.getElementById('progressFill');
      if (track && fill) {
        var pct = totalGroups > 1 ? ((currentGroup - 1) / (totalGroups - 1)) * 100 : 0;
        if (this.direction === 'rtl') {
          // RTL: progress goes from right to left — fill from the right side
          fill.style.right = '0';
          fill.style.left = 'auto';
          fill.style.width = pct + '%';
        } else {
          // LTR: normal left-to-right progress
          fill.style.left = '0';
          fill.style.right = 'auto';
          fill.style.width = pct + '%';
        }
      }
    };

    ReaderController.prototype._checkStripWarning = function () {
      var warn = this.shadowRoot ? this.shadowRoot.getElementById('stripWarn') : null;
      if (!warn) return;

      var visibleImgs = [];
      if (this.isSingleMode) {
        if (this.images[this.index]) visibleImgs.push(this.images[this.index]);
      } else {
        if (this.images[this.index]) visibleImgs.push(this.images[this.index]);
        if (this.images[this.index + 1]) visibleImgs.push(this.images[this.index + 1]);
      }

      var hasStrip = false;
      for (var i = 0; i < visibleImgs.length; i++) {
        if (visibleImgs[i] && visibleImgs[i].isStrip) { hasStrip = true; break; }
      }
      warn.style.display = hasStrip ? 'flex' : 'none';
    };

    // =========================================================================
    // Toast & Hint
    // =========================================================================

    ReaderController.prototype.showToast = function (msg) {
      var toast = this.shadowRoot ? this.shadowRoot.getElementById('toast') : null;
      if (!toast) return;

      toast.textContent = msg;
      toast.classList.add('visible');

      var self = this;
      clearTimeout(self._toastTimer);
      self._toastTimer = setTimeout(function () {
        toast.classList.remove('visible');
      }, 2000);
    };

    ReaderController.prototype.showPageToast = function (msg) {
      var el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText =
        'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);' +
        'z-index:2147483648;background:rgba(0,0,0,0.75);color:#fff;' +
        'font-size:13px;padding:8px 20px;border-radius:20px;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'pointer-events:none;';
      document.body.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2500);
    };

    ReaderController.prototype._showHint = function () {
      var hint = this.shadowRoot ? this.shadowRoot.getElementById('hint') : null;
      if (!hint) return;

      var self = this;
      setTimeout(function () {
        hint.classList.add('fading');
        setTimeout(function () {
          if (hint && hint.parentNode) hint.style.display = 'none';
        }, 600);
      }, CONFIG.HINT_AUTO_HIDE_MS);
    };

    // =========================================================================
    // Cleanup
    // =========================================================================

    ReaderController.prototype.destroy = function () {
      this.log('destroy...');

      // Remove event listeners
      if (this._boundKeydown) {
        window.removeEventListener('keydown', this._boundKeydown);
        this._boundKeydown = null;
      }
      if (this._boundResize) {
        window.removeEventListener('resize', this._boundResize);
        this._boundResize = null;
      }
      if (this._boundWheel) {
        window.removeEventListener('wheel', this._boundWheel);
        this._boundWheel = null;
      }

      // Restore body scroll
      document.body.style.overflow = this.originalOverflow || '';

      // Restore scroll position
      window.scrollTo(0, this.originalScrollY);

      // Remove overlay DOM
      if (this.overlayEl && this.overlayEl.parentNode) {
        this.overlayEl.parentNode.removeChild(this.overlayEl);
      }

      // Reset state
      this.overlayEl = null;
      this.shadowRoot = null;
      this.images = [];
      this.index = 0;
      this.active = false;
    };

    // =========================================================================
    // Helpers
    // =========================================================================

    ReaderController.prototype._escapeHtml = function (str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    ReaderController.prototype._getCSS = function () {
      var BG = CONFIG.BACKGROUND_COLOR;   // #F4F1EA warm paper
      var TX = '#8C8B85';                  // meta text
      var HI = '#3D3C38';                  // highlight/hover
      var LO = '#C5C3BB';                  // low-key / arrows
      var PROG_BG = '#D5D2C8';             // progress track
      var PROG_FILL = '#86C166';           // progress fill
      var TRANS = '0.18s ease-out';

      return [
        ':host { all:initial; }',
        '.reader-overlay {',
        '  position:fixed;inset:0;z-index:2147483647;',
        '  background:#FFFFFF;',
        '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
        '  display:flex;flex-direction:column;',
        '  user-select:none;-webkit-user-select:none;',
        '}',

        // ---- Top bar: absolute overlay, hidden by default, toggle with click ----
        '.top-bar {',
        '  display:flex;align-items:center;justify-content:space-between;',
        '  position:absolute;top:0;left:0;right:0;z-index:5;',
        '  height:38px;padding:0 12px;',
        '  background:rgba(255,255,255,0);',
        '  opacity:0;transform:translateY(-8px);pointer-events:none;',
        '  transition:opacity ' + TRANS + ',transform ' + TRANS + ',background ' + TRANS + ';',
        '}',
        '.top-bar.top-visible {',
        '  opacity:1;transform:translateY(0);pointer-events:auto;',
        '  background:rgba(255,255,255,0.88);',
        '  backdrop-filter:blur(10px);',
        '  -webkit-backdrop-filter:blur(10px);',
        '  border-bottom:1px solid rgba(0,0,0,0.06);',
        '}',
        '.top-bar-left, .top-bar-right {',
        '  flex:1;display:flex;align-items:center;gap:6px;',
        '}',
        '.top-bar-right { justify-content:flex-end; }',
        '.top-bar-left { min-width:0; }',
        '.top-bar-title {',
        '  font-size:12px;color:' + TX + ';letter-spacing:0.06em;',
        '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
        '  flex:1;text-align:center;',
        '}',

        // ---- Top bar buttons ----
        '.top-bar-btn {',
        '  display:flex;align-items:center;justify-content:center;',
        '  height:28px;padding:0 10px;border:none;border-radius:6px;',
        '  background:transparent;color:' + TX + ';cursor:pointer;',
        '  font-size:12px;white-space:nowrap;',
        '  transition:background 0.15s,color 0.15s;',
        '}',
        '.top-bar-btn:hover { background:rgba(0,0,0,0.05);color:' + HI + '; }',
        '.top-bar-btn.active { background:rgba(134,193,102,0.12);color:#4A8A2E; }',
        '.top-bar-btn.active:hover { background:rgba(134,193,102,0.20);color:#3A7020; }',

        // ---- Three-layer structure: top-bar / reading-stage / bottom-bar ----
        '.reading-stage {',
        '  flex:1;display:flex;align-items:center;justify-content:center;',
        '  min-height:0;position:relative;overflow:hidden;',
        '}',

        // ---- Viewport sits inside reading-stage ----
        '.viewport {',
        '  display:flex;align-items:center;justify-content:center;',
        '  position:relative;overflow:visible;',
        '  padding:8px 32px;',
        '}',
        '.click-zone {',
        '  position:absolute;top:0;bottom:0;width:50%;',
        '  cursor:pointer;z-index:1;',
        '}',
        '.click-zone.left { left:0; }',
        '.click-zone.right { right:0; }',

        // ---- Unified spread container — one visual object ----
        '.spread-container {',
        '  display:flex;align-items:center;justify-content:center;',
        '  gap:' + CONFIG.PAGE_GAP + 'px;',
        '  position:relative;z-index:2;pointer-events:none;',
        '}',
        '.spread-container > * { pointer-events:auto; }',
        '.page-wrapper {',
        '  display:flex;align-items:center;justify-content:center;',
        '  max-height:' + CONFIG.MAX_IMAGE_HEIGHT_VH + 'vh;',
        '  overflow:visible;',
        '}',
        '.page-wrapper img {',
        '  max-width:100%;max-height:' + CONFIG.MAX_IMAGE_HEIGHT_VH + 'vh;',
        '  object-fit:contain;display:block;',
        '}',
        '.page-wrapper.panorama { max-width:90vw; }',
        '.page-wrapper.panorama img { max-width:90vw; }',
        '.page-wrapper.error-state {',
        '  display:flex;flex-direction:column;align-items:center;',
        '  justify-content:center;gap:8px;color:' + TX + ';font-size:12px;',
        '}',
        '.page-wrapper.error-state .retry-btn {',
        '  padding:6px 16px;border:1px solid ' + LO + ';border-radius:4px;',
        '  background:' + BG + ';color:' + TX + ';cursor:pointer;font-size:12px;',
        '}',

        // ---- Arrow buttons — fixed to reading-stage edges, no background ----
        '.arrow-btn {',
        '  position:absolute;top:50%;transform:translateY(-50%);',
        '  z-index:3;',
        '  width:40px;height:40px;',
        '  border:none;background:transparent;',
        '  color:' + TX + ';',
        '  display:flex;align-items:center;justify-content:center;',
        '  cursor:pointer;line-height:1;',
        '  transition:color ' + TRANS + ';',
        '}',
        '.arrow-btn svg { width:22px;height:22px; }',
        '.arrow-btn:hover { color:' + HI + '; }',
        '.arrow-btn.left { left:12px; }',
        '.arrow-btn.right { right:12px; }',

        // ---- Bottom bar — absolute overlay, hidden, toggle with click ----
        '.bottom-bar {',
        '  display:flex;flex-direction:column;align-items:center;',
        '  justify-content:center;gap:6px;',
        '  position:absolute;bottom:0;left:0;right:0;z-index:5;',
        '  padding:8px 32px 12px;',
        '  opacity:0;transform:translateY(8px);',
        '  transition:opacity ' + TRANS + ',transform ' + TRANS + ';',
        '  pointer-events:none;',
        '}',
        '.bottom-bar.bottom-visible {',
        '  opacity:1;transform:translateY(0);pointer-events:auto;',
        '}',
        '.bottom-bar-row {',
        '  display:flex;align-items:center;justify-content:center;gap:10px;',
        '  width:100%;',
        '}',
        '.bottom-bar-meta {',
        '  margin-top:4px;',
        '  justify-content:space-between;',
        '  max-width:1320px;',
        '  width:100%;',
        '}',
        '.collection-nav-btn {',
        '  font-size:11px;color:' + TX + ';text-decoration:none;cursor:pointer;',
        '  padding:2px 6px;border-radius:3px;flex-shrink:0;white-space:nowrap;',
        '  transition:color ' + TRANS + ',background ' + TRANS + ';',
        '  pointer-events:auto;',
        '}',
        '.collection-nav-btn:hover {',
        '  color:' + HI + ';background:rgba(0,0,0,0.04);',
        '}',
        '.page-indicator {',
        '  font-size:11px;color:' + TX + ';white-space:nowrap;',
        '  font-variant-numeric:tabular-nums;',
        '}',
        '.page-total {',
        '  font-size:11px;color:' + TX + ';white-space:nowrap;',
        '  font-variant-numeric:tabular-nums;',
        '}',
        '.progress-track {',
        '  width:100%;max-width:1320px;height:4px;position:relative;',
        '  background:' + PROG_BG + ';border-radius:1px;overflow:hidden;',
        '}',
        '.progress-fill {',
        '  position:absolute;top:0;height:100%;',
        '  background:' + PROG_FILL + ';border-radius:1px;',
        '  transition:width 0.2s ease;',
        '}',

        // ---- Toast ----
        '.toast {',
        '  position:fixed;bottom:60px;left:50%;transform:translateX(-50%);',
        '  z-index:10;',
        '  background:rgba(0,0,0,0.7);color:#fff;',
        '  font-size:12px;padding:6px 18px;border-radius:16px;',
        '  opacity:0;transition:opacity ' + TRANS + ';',
        '  pointer-events:none;',
        '}',
        '.toast.visible { opacity:1; }',

        // ---- Hint overlay ----
        '.hint-overlay {',
        '  position:fixed;bottom:80px;left:50%;transform:translateX(-50%);',
        '  z-index:10;',
        '  background:rgba(61,60,56,0.85);color:#fff;',
        '  font-size:12px;padding:8px 20px;border-radius:20px;',
        '  display:flex;align-items:center;gap:14px;',
        '  transition:opacity 0.5s;',
        '  pointer-events:none;white-space:nowrap;',
        '}',
        '.hint-overlay.fading { opacity:0; }',
        '.hint-arrow { font-size:15px; }',

        // ---- Strip warning ----
        '.strip-warning {',
        '  background:#fff3cd;color:#856404;',
        '  font-size:11px;padding:5px 16px;text-align:center;',
        '  flex-shrink:0;',
        '  display:flex;align-items:center;justify-content:center;gap:12px;',
        '}',
        '.close-warn-btn {',
        '  background:none;border:none;color:#856404;',
        '  cursor:pointer;font-size:15px;line-height:1;padding:0 4px;',
        '}',

        // ---- Legacy compat ----
        '.top-bar-actions { display:none; }',
      ].join('');
    };

    // Expose getInstance
    ReaderController.getInstance = getInstance;
    return ReaderController;
  })();

  // ===========================================================================
  // Bootstrap
  // ===========================================================================

  var reader = ReaderController.getInstance();

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.action === 'toggle') {
      if (DEBUG) console.log('[ComicReader] received toggle message');
      reader.toggle();
    }
    sendResponse({ ok: true });
  });

  if (DEBUG) console.log('[ComicReader] content script loaded, ready for toggle messages');
})();
