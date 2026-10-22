/* =============================================
   كتبي — تطبيق الويب التعليمي العراقي
   Iraqi Educational Books Platform — Application Logic
   ============================================= */
'use strict';

// =================== State ===================
const state = {
  data: null,
  currentGrade: null,
  theme: localStorage.getItem('kutubi-theme') || 'light',
  subjectFilter: 'all',
  searchQuery: '',
  mobileMenuOpen: false,
};

// =================== Book Overrides (localStorage) ===================
const BOOK_OVERRIDES_KEY = 'kutubi_book_overrides';

function getBookOverrides() {
  try { return JSON.parse(localStorage.getItem(BOOK_OVERRIDES_KEY) || '{}'); }
  catch { return {}; }
}

function saveBookOverrides(overrides) {
  localStorage.setItem(BOOK_OVERRIDES_KEY, JSON.stringify(overrides));
}

function applyBookOverrides() {
  const overrides = getBookOverrides();
  if (!state.data) return;
  state.data.grades.forEach(grade => {
    // Check if new books were added in admin
    if (Array.isArray(overrides[`_new_books_${grade.id}`])) {
      overrides[`_new_books_${grade.id}`].forEach(newBook => {
        if (!grade.books.some(b => b.id === newBook.id)) {
          grade.books.push(JSON.parse(JSON.stringify(newBook)));
        }
      });
    }

    // Check deleted books in admin
    if (Array.isArray(overrides[`_deleted_books_${grade.id}`])) {
      const deletedIds = overrides[`_deleted_books_${grade.id}`];
      grade.books = grade.books.filter(b => !deletedIds.includes(b.id));
    }

    grade.books.forEach(book => {
      const key = book.id;
      if (overrides[key]) {
        const ov = overrides[key];
        if (ov.nameAr) book.nameAr = ov.nameAr;
        if (ov.subject) book.subject = ov.subject;
        if (typeof ov.partsCount === 'number' && ov.partsCount !== book.parts.length) {
          const current = book.parts.length;
          const target = ov.partsCount;
          if (target > current) {
            for (let i = current; i < target; i++) {
              const partNum = i + 1;
              book.parts.push({
                part: partNum,
                title: `${book.nameAr} — الجزء ${partNum === 1 ? 'الأول' : partNum === 2 ? 'الثاني' : 'الثالث'}`,
                openUrl: '', downloadUrl: '',
                fileName: `${book.nameAr} - الجزء ${partNum} - ${grade.nameAr}.pdf`,
                format: 'PDF',
                suggestedFileName: `${book.id}-p${partNum}.pdf`
              });
            }
          } else if (target < current) {
            book.parts = book.parts.slice(0, target);
          }
        }
      }
    });
  });
}

// =================== PDF Storage Manager (IndexedDB + LocalStorage) ===================
const PDFStorage = {
  dbName: 'KutubiPDFStorage',
  storeName: 'books_pdf',
  db: null,
  objectUrls: {},

  async init() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB is not supported');
        resolve(null);
        return;
      }
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'key' });
        }
      };
      req.onsuccess = async (e) => {
        this.db = e.target.result;
        await this.preloadBlobs();
        resolve(this.db);
      };
      req.onerror = () => {
        console.warn('IndexedDB failed to open');
        resolve(null);
      };
    });
  },

  async preloadBlobs() {
    if (!this.db) return;
    try {
      const tx = this.db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        items.forEach(item => {
          if (item && item.blob) {
            this.objectUrls[item.key] = URL.createObjectURL(item.blob);
          }
        });
      };
    } catch (e) {
      console.warn('Failed to preload PDF blobs', e);
    }
  },

  getRegistry() {
    try {
      return JSON.parse(localStorage.getItem('kutubi_pdf_registry') || '{}');
    } catch {
      return {};
    }
  },

  setRegistry(reg) {
    localStorage.setItem('kutubi_pdf_registry', JSON.stringify(reg));
  },

  async saveFile(bookId, partNum, file) {
    const key = `${bookId}_p${partNum}`;
    const fileSizeFormatted = formatBytes(file.size);
    const item = {
      key,
      bookId,
      partNum,
      type: 'file',
      fileName: file.name,
      fileSize: fileSizeFormatted,
      blob: file,
      updatedAt: Date.now()
    };

    if (this.db) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    if (this.objectUrls[key]) {
      URL.revokeObjectURL(this.objectUrls[key]);
    }
    this.objectUrls[key] = URL.createObjectURL(file);

    const reg = this.getRegistry();
    reg[key] = {
      type: 'file',
      fileName: file.name,
      fileSize: fileSizeFormatted,
      hasBlob: true,
      updatedAt: Date.now()
    };
    this.setRegistry(reg);
    return item;
  },

  async saveUrl(bookId, partNum, url, customFileName) {
    const key = `${bookId}_p${partNum}`;
    const cleanUrl = url.trim();

    if (this.db) {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(key);
      } catch (e) {}
    }
    if (this.objectUrls[key]) {
      URL.revokeObjectURL(this.objectUrls[key]);
      delete this.objectUrls[key];
    }

    const reg = this.getRegistry();
    reg[key] = {
      type: 'url',
      url: cleanUrl,
      fileName: customFileName || '',
      updatedAt: Date.now()
    };
    this.setRegistry(reg);
  },

  async removePdf(bookId, partNum) {
    const key = `${bookId}_p${partNum}`;
    const reg = this.getRegistry();
    delete reg[key];
    this.setRegistry(reg);

    if (this.db) {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(key);
      } catch (e) {}
    }
    if (this.objectUrls[key]) {
      URL.revokeObjectURL(this.objectUrls[key]);
      delete this.objectUrls[key];
    }
  },

  getPartPdfInfo(bookId, partNum, defaultPart = {}) {
    const key = `${bookId}_p${partNum}`;
    const reg = this.getRegistry();
    const entry = reg[key];

    if (entry) {
      if (entry.type === 'file') {
        const objUrl = this.objectUrls[key];
        return {
          hasPdf: true,
          type: 'file',
          openUrl: objUrl || '#',
          downloadUrl: objUrl || '#',
          fileName: entry.fileName || `${defaultPart.fileName || 'book'}.pdf`,
          fileSize: entry.fileSize || ''
        };
      } else if (entry.type === 'url' && entry.url) {
        return {
          hasPdf: true,
          type: 'url',
          openUrl: entry.url,
          downloadUrl: entry.url,
          fileName: entry.fileName || defaultPart.fileName || 'book.pdf',
          fileSize: ''
        };
      }
    }

    // Fallback: check if part in data.json has openUrl
    if (defaultPart && defaultPart.openUrl && defaultPart.openUrl.trim() !== '') {
      return {
        hasPdf: true,
        type: 'default',
        openUrl: defaultPart.openUrl,
        downloadUrl: defaultPart.downloadUrl || defaultPart.openUrl,
        fileName: defaultPart.fileName || 'book.pdf',
        fileSize: ''
      };
    }

    return { hasPdf: false };
  }
};

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// =================== DOM Ready ===================
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(state.theme);
  await PDFStorage.init();
  await loadData();
  applyBookOverrides();
  renderNav();
  renderHomePage();
  initSearch();
  initScrollBehavior();
  updateDarkToggle();
});

// =================== Load Data ===================
async function loadData() {
  // Use pre-bundled data (works with file:// protocol)
  if (window.KUTUBI_DATA) {
    state.data = window.KUTUBI_DATA;
    return;
  }
  // Fallback: fetch from server (HTTP/HTTPS)
  try {
    const res = await fetch('./data.json');
    state.data = await res.json();
  } catch (e) {
    console.error('Failed to load data.json', e);
  }
}

// =================== Theme ===================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  state.theme = theme;
  localStorage.setItem('kutubi-theme', theme);
}

function toggleTheme() {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
  updateDarkToggle();
}

function updateDarkToggle() {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

// =================== Navigation ===================
function renderNav() {
  const nav = document.getElementById('main-nav');
  if (!nav || !state.data) return;

  const gradesHtml = state.data.grades.map(g => `
    <button class="nav-grade-btn" 
            id="nav-btn-${g.id}"
            onclick="navigateToGrade('${g.id}')">
      ${g.shortName}
    </button>
  `).join('');

  const mobileGradesHtml = state.data.grades.map(g => `
    <button class="mobile-grade-btn"
            onclick="navigateToGrade('${g.id}'); closeMobileMenu();">
      <span style="font-size:1.15rem">${getGradeEmoji(g.order)}</span>
      ${g.nameAr}
    </button>
  `).join('');

  nav.innerHTML = `
    <div class="nav-container">
      <a class="nav-logo" href="#" onclick="navigateHome(); return false;" aria-label="كتبي - الرئيسية">
        <div class="nav-logo-icon">📚</div>
        <span class="nav-logo-text">كتبي <span>العراق</span></span>
      </a>
      <div class="nav-grades" role="navigation" aria-label="التنقل بين الصفوف">
        ${gradesHtml}
      </div>
      <div class="nav-actions">
        <button class="btn-icon" id="theme-toggle" onclick="toggleTheme()" aria-label="تبديل الوضع">🌙</button>
        <button class="btn-icon hamburger" id="hamburger-btn" onclick="toggleMobileMenu()" aria-label="القائمة" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>
    <div class="mobile-menu" id="mobile-menu" role="navigation" aria-label="قائمة الصفوف للموبايل">
      ${mobileGradesHtml}
    </div>
  `;
}

function toggleMobileMenu() {
  state.mobileMenuOpen = !state.mobileMenuOpen;
  const menu = document.getElementById('mobile-menu');
  const btn = document.getElementById('hamburger-btn');
  if (menu) menu.classList.toggle('open', state.mobileMenuOpen);
  if (btn) btn.setAttribute('aria-expanded', state.mobileMenuOpen);
}

function closeMobileMenu() {
  state.mobileMenuOpen = false;
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.remove('open');
}

function setActiveNavBtn(gradeId) {
  document.querySelectorAll('.nav-grade-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  if (gradeId) {
    const btn = document.getElementById(`nav-btn-${gradeId}`);
    if (btn) btn.classList.add('active');
  }
}

// =================== Home Page ===================
function renderHomePage() {
  const homePage = document.getElementById('home-page');
  if (!homePage || !state.data) return;

  const totalBooks = state.data.grades.reduce((sum, g) =>
    sum + g.books.reduce((s2, b) => s2 + b.parts.length, 0), 0);
  const totalSubjects = Object.keys(state.data.subjects).length;

  const filterChips = buildSubjectChips();
  const gradeCards = state.data.grades.map((g, i) => buildGradeCard(g, i)).join('');

  homePage.innerHTML = `
    <div class="container">
      
      <!-- Hero Banner (تصميم هادئ ومستوحى من الصورة) -->
      <section class="hero-wrapper animate-in" aria-label="القسم الرئيسي">
        <div class="hero-card">
          <div class="hero-card-content">
            <div class="hero-greeting">
              <span>✨</span>
              <span>منصة المناهج المدرسية العراقية المعتمدة</span>
            </div>
            <h1 class="hero-title">مكتبة الكتب المدرسية الرسمية</h1>
            <div class="hero-divider">
              <span></span><span></span><span></span><span></span>
            </div>
            <p class="hero-desc">
              جميع الكتب المدرسية للمرحلتين المتوسطة والإعدادية العلمية وفق أحدث طبعات
              ${state.data.meta.ministry} (${state.data.meta.curriculum})، منظمة وسهلة التصفح والتحميل.
            </p>

            <!-- Stats pills inside the card -->
            <div class="hero-stats-row">
              <div class="hero-stat-pill">
                <span class="hero-stat-icon">🏫</span>
                <div>
                  <div class="hero-stat-num">6</div>
                  <div class="hero-stat-label">صفوف دراسية</div>
                </div>
              </div>
              <div class="hero-stat-pill">
                <span class="hero-stat-icon">📖</span>
                <div>
                  <div class="hero-stat-num">${totalSubjects}</div>
                  <div class="hero-stat-label">مادة مقررة</div>
                </div>
              </div>
              <div class="hero-stat-pill">
                <span class="hero-stat-icon">📄</span>
                <div>
                  <div class="hero-stat-num">${totalBooks}+</div>
                  <div class="hero-stat-label">كتاب ومنهج</div>
                </div>
              </div>
              <div class="hero-stat-pill">
                <span class="hero-stat-icon">📅</span>
                <div>
                  <div class="hero-stat-num">2025</div>
                  <div class="hero-stat-label">طبعة المنهج</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Academic Seal Emblem -->
          <div class="hero-emblem">
            <div class="emblem-circle">
              <span class="emblem-icon">🇮🇶</span>
              <span class="emblem-text">جمهورية العراق<br>وزارة التربية</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Search & Filters -->
      <section class="search-filter-section animate-in stagger-2" aria-label="البحث والفلترة">
        <div class="search-wrapper" id="hero-search-wrapper">
          <div class="search-bar" role="search">
            <span class="search-icon">🔍</span>
            <input type="search" 
                   class="search-input" 
                   id="global-search" 
                   placeholder="ابحث عن كتاب، مادة، أو صف دراسي..." 
                   aria-label="البحث في الكتب"
                   autocomplete="off">
            <button class="search-clear" id="search-clear-btn" aria-label="مسح البحث">✕</button>
          </div>
          <div class="search-results" id="search-results" role="listbox" aria-label="نتائج البحث"></div>
        </div>

        <!-- Subject filter chips -->
        <div class="filter-chips" id="filter-chips" role="group" aria-label="تصفية حسب المادة">
          ${filterChips}
        </div>
      </section>

      <!-- Main Panel (القوائم الرئيسية) -->
      <section class="main-panel animate-in stagger-3" aria-label="الصفوف الدراسية">
        <div class="main-panel-top-tab"></div>
        
        <div class="panel-header">
          <div class="panel-header-right">
            <div class="panel-icon-badge">📑</div>
            <div>
              <h2 class="panel-title">القوائم الرئيسية</h2>
              <p class="panel-subtitle">اختر القسم أو الصف الدراسي لتصفح المناهج والكتب المقررة</p>
            </div>
          </div>
          <span class="panel-count-badge" id="grades-count">6 صفوف</span>
        </div>

        <!-- Grades Grid -->
        <div class="grades-grid" id="grades-grid" role="list">
          ${gradeCards}
        </div>

        <div class="empty-state" id="grades-empty" style="display:none">
          <div class="empty-state-icon">🔍</div>
          <div class="empty-state-title">لا توجد كتب مطابقة للبحث</div>
          <div class="empty-state-desc">جرّب البحث بكلمات مختلفة أو إزالة الفلتر</div>
        </div>
      </section>

    </div>

    <!-- Footer -->
    ${buildFooter()}
  `;

  // Re-init chips click listener
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const subj = chip.dataset.subject;
      state.subjectFilter = subj;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filterGradeCards(subj);
    });
  });
}

function buildGradeCard(g, index) {
  const subjectTags = g.books.map(b => {
    const subj = state.data.subjects[b.subject];
    const isMulti = b.parts.length > 1;
    const badgeText = isMulti ? 'جزئين' : 'جزء ١';
    return `
      <span class="grade-tag" title="${b.nameAr} (${isMulti ? 'جزئين' : 'جزء واحد'})">
        ${subj ? subj.emoji : '📖'} ${b.nameAr}
        <span class="tag-parts-count ${isMulti ? 'multi' : 'single'}">${badgeText}</span>
      </span>
    `;
  }).join('');

  const totalParts = g.books.reduce((s, b) => s + b.parts.length, 0);
  const levelText = g.level === 'middle' ? 'المرحلة المتوسطة' : 'المرحلة الإعدادية (الفرع العلمي)';
  const delayClass = `stagger-${Math.min(index + 1, 6)}`;

  return `
    <article class="grade-card animate-in ${delayClass}" 
             role="listitem"
             onclick="navigateToGrade('${g.id}')"
             tabindex="0"
             aria-label="${g.nameAr}">
      <!-- Golden bookmark ribbon hanging from top -->
      <div class="card-ribbon" title="معتمد وزارياً"></div>

      <div class="grade-card-top">
        <div class="grade-squircle-icon">${getGradeEmoji(g.order)}</div>
        <div class="grade-card-titles">
          <h3 class="grade-card-name">${g.nameAr}</h3>
          <div class="grade-card-stage">${levelText}</div>
        </div>
      </div>

      <p class="grade-card-desc">
        يشمل جميع المناهج الرسمية المعتمدة لوزارة التربية بواقع ${g.books.length} مواد أساسية (${totalParts} كتاب وجزء).
      </p>

      <div class="grade-tags-preview" aria-label="قائمة المواد والكتب">${subjectTags}</div>

      <div class="grade-card-footer">
        <span class="grade-count-pill">
          <span>📚</span>
          <span>${g.books.length} مواد • ${totalParts} كتاب</span>
        </span>
        <button class="grade-btn-open" onclick="navigateToGrade('${g.id}'); event.stopPropagation();">
          تصفح الكتب <span>←</span>
        </button>
      </div>
    </article>
  `;
}

function buildSubjectChips() {
  const subjects = state.data.subjects;
  const allChip = `<button class="chip active" data-subject="all">الكل</button>`;
  const chips = Object.entries(subjects).map(([key, s]) =>
    `<button class="chip" data-subject="${key}">${s.emoji} ${s.nameAr}</button>`
  ).join('');
  return allChip + chips;
}

function filterGradeCards(subject) {
  const grid = document.getElementById('grades-grid');
  const empty = document.getElementById('grades-empty');
  const count = document.getElementById('grades-count');

  let visible = 0;
  state.data.grades.forEach(g => {
    const card = document.querySelector(`[onclick="navigateToGrade('${g.id}')"]`);
    if (!card) return;
    const hasSubject = subject === 'all' || g.books.some(b => b.subject === subject);
    card.style.display = hasSubject ? '' : 'none';
    if (hasSubject) visible++;
  });

  if (empty) empty.style.display = visible === 0 ? 'block' : 'none';
  if (count) count.textContent = `${visible} صفوف`;
}

// =================== Grade Page (SPA) ===================
function navigateToGrade(gradeId) {
  closeMobileMenu();
  const grade = state.data.grades.find(g => g.id === gradeId);
  if (!grade) return;

  state.currentGrade = grade;
  setActiveNavBtn(gradeId);

  const homePage = document.getElementById('home-page');
  const gradePage = document.getElementById('grade-page');

  homePage.classList.add('hidden');
  gradePage.classList.add('active');
  gradePage.style.display = 'block';

  renderGradePage(grade);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigateHome() {
  state.currentGrade = null;
  setActiveNavBtn(null);

  const homePage = document.getElementById('home-page');
  const gradePage = document.getElementById('grade-page');

  homePage.classList.remove('hidden');
  gradePage.classList.remove('active');
  gradePage.style.display = 'none';

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderGradePage(grade) {
  const gradePage = document.getElementById('grade-page');
  const totalParts = grade.books.reduce((s, b) => s + b.parts.length, 0);
  const levelText = grade.level === 'middle' ? 'المرحلة المتوسطة' : 'المرحلة الإعدادية (الفرع العلمي)';

  const gradeNavPills = state.data.grades.map(g => `
    <button class="grade-nav-pill ${g.id === grade.id ? 'active' : ''}"
            onclick="navigateToGrade('${g.id}')">
      ${g.nameAr}
    </button>
  `).join('');

  const bookCards = grade.books.map((book, i) => buildBookCard(book, grade, i)).join('');

  gradePage.innerHTML = `
    <div class="container">
      
      <!-- Grade Header Panel -->
      <header class="grade-header-panel animate-in" aria-label="رأس صفحة ${grade.nameAr}">
        <nav aria-label="مسار التنقل" class="breadcrumbs">
          <a href="#" onclick="navigateHome(); return false;">الرئيسية</a>
          <span class="sep">›</span>
          <span class="current">${grade.nameAr}</span>
        </nav>

        <button class="btn-back" onclick="navigateHome()" aria-label="العودة للرئيسية">
          → العودة للصفحة الرئيسية
        </button>

        <div class="grade-meta-box">
          <div class="grade-meta-icon">${getGradeEmoji(grade.order)}</div>
          <div class="grade-meta-text">
            <h1 class="grade-page-title">${grade.nameAr}</h1>
            <p class="grade-page-subtitle">${levelText} • منهج وزارة التربية العراقية المعتمد</p>
            <div class="grade-stats-chips">
              <span class="grade-stat-badge">📚 ${grade.books.length} مواد دراسية</span>
              <span class="grade-stat-badge">📄 ${totalParts} كتاب وجزء</span>
              <span class="grade-stat-badge" id="grade-pdf-count">📕 ${countGradePdfs(grade)} كتاب PDF مضاف</span>
              <span class="grade-stat-badge">✨ منهج وزارة التربية</span>
            </div>
          </div>
        </div>

        <!-- Grade switcher pills -->
        <div class="grade-nav-pills" role="navigation" aria-label="الانتقال لصف آخر">
          ${gradeNavPills}
        </div>
      </header>

      <!-- Books Section -->
      <section class="books-section animate-in stagger-2" aria-label="كتب ومقررات ${grade.nameAr}">
        <div class="books-toolbar">
          <div class="panel-header-right">
            <div class="panel-icon-badge">📖</div>
            <div>
              <h2 class="panel-title">الكتب المقررة</h2>
              <p class="panel-subtitle">جميع المناهج الدراسية لـ ${grade.nameAr} — يمكنك قراءة وتحميل الكتب بصيغة PDF مباشرة</p>
            </div>
          </div>
          
          <div class="books-toolbar-actions">
            <div class="books-search-box">
              <span>🔍</span>
              <input type="search"
                     id="grade-search"
                     placeholder="ابحث في كتب ${grade.nameAr}..."
                     oninput="filterBookCards(this.value)"
                     aria-label="البحث في كتب ${grade.nameAr}">
            </div>
          </div>
        </div>

        <div class="books-grid" id="books-grid" role="list">
          ${bookCards}
        </div>

        <div class="empty-state" id="books-empty" style="display:none">
          <div class="empty-state-icon">🔍</div>
          <div class="empty-state-title">لا توجد نتائج مطابقة</div>
          <div class="empty-state-desc">جرّب البحث باسم كتاب مختلف</div>
        </div>
      </section>

    </div>

    ${buildFooter()}
  `;
}

function countGradePdfs(grade) {
  let count = 0;
  grade.books.forEach(b => {
    b.parts.forEach((p, idx) => {
      const partNum = typeof p.part === 'number' ? p.part : idx;
      const info = PDFStorage.getPartPdfInfo(b.id, partNum, p);
      if (info.hasPdf) count++;
    });
  });
  return count;
}

function buildBookCard(book, grade, index) {
  const subj = state.data.subjects[book.subject] || { emoji: '📖', color: '#163e2c', nameAr: book.nameAr };
  const delayClass = `stagger-${Math.min(index + 1, 6)}`;
  const isMultiPart = book.parts.length > 1;

  const partsHtml = book.parts.map((part, pIdx) => {
    let label = part.title;
    if (!label || label === book.nameAr) {
      label = part.part === 0
        ? 'الكتاب كاملاً (جزء واحد)'
        : (part.part === 1 ? 'الجزء الأول' : 'الجزء الثاني');
    }
    const partNum = typeof part.part === 'number' ? part.part : pIdx;
    const pdfInfo = PDFStorage.getPartPdfInfo(book.id, partNum, part);
    const dlFileName = pdfInfo.fileName || `${book.nameAr} - ${label} - ${grade.nameAr}.pdf`;

    let actionsHtml = '';
    if (pdfInfo.hasPdf) {
      actionsHtml = `
        <a class="btn-part btn-open" 
           href="${pdfInfo.openUrl}" target="_blank" rel="noopener noreferrer"
           title="فتح وقراءة ${label} بصيغة PDF في المتصفح"
           aria-label="قراءة ${label} بصيغة PDF">
          📖 قراءة PDF
        </a>
        <a class="btn-part btn-download"
           href="${pdfInfo.downloadUrl}"
           download="${dlFileName}"
           onclick="triggerDownloadToast('${book.nameAr} - ${label}')"
           title="حفظ وتحميل ${label} على جهازك"
           aria-label="حفظ ${label} بصيغة PDF">
          ⬇️ تحميل
        </a>
      `;
    } else {
      actionsHtml = `
        <span class="part-empty-hint">غير متوفر حالياً</span>
      `;
    }

    return `
      <div class="part-row" id="row-${book.id}-p${partNum}">
        <span class="part-label">
          <span class="part-icon">${part.part === 0 ? '📘' : (part.part === 1 ? '📗' : '📙')}</span>
          <span class="part-title-text">${label}</span>
        </span>
        <div class="part-actions">
          ${actionsHtml}
        </div>
      </div>
    `;
  }).join('');

  const partsBadgeText = isMultiPart ? 'جزئين (الجزء الأول والثاني)' : 'جزء واحد (منهج كامل)';
  const partsBadgeClass = isMultiPart ? 'badge-multi-part' : 'badge-single-part';

  return `
    <article class="book-card animate-in ${delayClass}"
             role="listitem"
             data-subject="${book.subject}"
             data-name="${book.nameAr}">
      <div class="book-card-header">
        <div class="subject-icon-wrap" aria-hidden="true">${subj.emoji}</div>
        <div class="book-info">
          <div class="book-header-top-row">
            <h3 class="book-subject-name">${book.nameAr}</h3>
            <div class="book-header-actions">
              <span class="book-grade-badge">${grade.shortName}</span>
            </div>
          </div>
          <div class="book-badges-row">
            <span class="book-parts-indicator ${partsBadgeClass}">
              ${isMultiPart ? '📚' : '📄'} ${partsBadgeText}
            </span>
            <span class="book-format-badge">📕 PDF</span>
          </div>
        </div>
      </div>
      <div class="book-parts">${partsHtml}</div>
    </article>
  `;
}

// =================== Book Edit Modal ===================
let currentBookEditContext = null;

function openBookEditModal(gradeId, bookId) {
  const grade = state.data.grades.find(g => g.id === gradeId);
  if (!grade) return;
  const book = grade.books.find(b => b.id === bookId);
  if (!book) return;

  currentBookEditContext = { gradeId, bookId, grade, book };

  const container = document.getElementById('pdf-modal-container');
  if (!container) return;

  const currentParts = book.parts.length;

  container.innerHTML = `
    <div class="modal-overlay open" id="book-edit-modal" onclick="handleBookEditOverlayClick(event)">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="book-edit-title">
        <div class="modal-header">
          <div class="modal-header-titles">
            <div class="modal-header-icon">✏️</div>
            <div>
              <h3 class="modal-title" id="book-edit-title">تعديل بيانات الكتاب</h3>
              <div class="modal-subtitle">${grade.nameAr} — ${book.nameAr}</div>
            </div>
          </div>
          <button class="modal-close-btn" onclick="closeBookEditModal()" aria-label="إغلاق">✕</button>
        </div>

        <div class="modal-body">
          <div class="modal-input-group">
            <label class="modal-section-title" for="book-edit-name">اسم الكتاب (المادة):</label>
            <input type="text"
                   class="modal-input"
                   id="book-edit-name"
                   value="${book.nameAr}"
                   placeholder="مثال: الكيمياء"
                   maxlength="80">
          </div>

          <div class="modal-input-group">
            <label class="modal-section-title" for="book-edit-parts">عدد الأجزاء:</label>
            <div class="parts-selector">
              <button class="parts-btn ${currentParts === 1 ? 'active' : ''}" onclick="selectPartsCount(1)" id="parts-btn-1">📄 جزء واحد</button>
              <button class="parts-btn ${currentParts === 2 ? 'active' : ''}" onclick="selectPartsCount(2)" id="parts-btn-2">📚 جزئان</button>
              <button class="parts-btn ${currentParts === 3 ? 'active' : ''}" onclick="selectPartsCount(3)" id="parts-btn-3">📦 ثلاثة أجزاء</button>
            </div>
            <input type="hidden" id="book-edit-parts-val" value="${currentParts}">
          </div>

          <div class="modal-tip-box">
            ⚠️ <strong>تنبيه:</strong> تقليل عدد الأجزاء سيحذف الأجزاء الزائدة ومرفقات الـ PDF الخاصة بها.
          </div>
        </div>

        <div class="modal-footer">
          <div></div>
          <div class="modal-actions-right">
            <button class="btn-modal-cancel" onclick="closeBookEditModal()">إلغاء</button>
            <button class="btn-modal-save" onclick="handleSaveBookEdit()">حفظ التعديلات ✅</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function selectPartsCount(n) {
  document.getElementById('book-edit-parts-val').value = n;
  [1, 2, 3].forEach(i => {
    const btn = document.getElementById(`parts-btn-${i}`);
    if (btn) btn.classList.toggle('active', i === n);
  });
}

function handleBookEditOverlayClick(e) {
  if (e.target && e.target.id === 'book-edit-modal') closeBookEditModal();
}

function closeBookEditModal() {
  const modal = document.getElementById('book-edit-modal');
  if (modal) {
    modal.classList.remove('open');
    setTimeout(() => {
      const container = document.getElementById('pdf-modal-container');
      if (container) container.innerHTML = '';
    }, 250);
  }
  currentBookEditContext = null;
}

function handleSaveBookEdit() {
  if (!currentBookEditContext) return;
  const { gradeId, bookId, grade, book } = currentBookEditContext;

  const newName = (document.getElementById('book-edit-name').value || '').trim();
  const newParts = parseInt(document.getElementById('book-edit-parts-val').value, 10);

  if (!newName) { showToast('يرجى إدخال اسم الكتاب ⚠️', 'info'); return; }
  if (!newParts || newParts < 1 || newParts > 3) { showToast('عدد الأجزاء غير صحيح', 'info'); return; }

  // Persist to overrides
  const overrides = getBookOverrides();
  overrides[bookId] = { nameAr: newName, partsCount: newParts };
  saveBookOverrides(overrides);

  // Apply to in-memory data
  book.nameAr = newName;

  const partArabic = ['', 'الأول', 'الثاني', 'الثالث'];
  const currentCount = book.parts.length;
  if (newParts > currentCount) {
    for (let i = currentCount; i < newParts; i++) {
      const pNum = i === 0 ? 0 : i + 1;
      book.parts.push({
        part: pNum,
        title: `${newName} — الجزء ${partArabic[i + 1] || (i + 1)}`,
        openUrl: '', downloadUrl: '',
        fileName: `${newName} - الجزء ${i + 1} - ${grade.nameAr}.pdf`,
        format: 'PDF',
        suggestedFileName: `${bookId}-p${i + 1}.pdf`
      });
    }
  } else if (newParts < currentCount) {
    book.parts = book.parts.slice(0, newParts);
  }

  // Update part titles
  book.parts.forEach((p, idx) => {
    if (newParts === 1) {
      p.part = 0;
      p.title = newName;
    } else {
      p.part = idx + 1;
      p.title = `${newName} — الجزء ${partArabic[idx + 1] || (idx + 1)}`;
    }
    p.fileName = p.title + ` - ${grade.nameAr}.pdf`;
  });

  closeBookEditModal();
  showToast(`تم تحديث بيانات كتاب «${newName}» بنجاح ✅`, 'success');

  // Re-render the grade page
  setTimeout(() => {
    if (state.currentGrade && state.currentGrade.id === gradeId) {
      renderGradePage(grade);
    }
  }, 300);
}

// =================== Modal Logic & User PDF Addition ===================
let currentModalContext = null;

function openPdfModal(gradeId, bookId, partNum) {
  const grade = state.data.grades.find(g => g.id === gradeId);
  if (!grade) return;
  const book = grade.books.find(b => b.id === bookId);
  if (!book) return;
  const part = book.parts.find(p => (typeof p.part === 'number' ? p.part : 0) === partNum) || book.parts[0];
  if (!part) return;

  let label = part.title;
  if (!label || label === book.nameAr) {
    label = part.part === 0 ? 'الكتاب كاملاً' : (part.part === 1 ? 'الجزء الأول' : 'الجزء الثاني');
  }

  const pdfInfo = PDFStorage.getPartPdfInfo(book.id, partNum, part);
  const suggestedFileName = part.suggestedFileName || (book.parts.length === 1 ? `${book.id}.pdf` : `${book.id}-p${(part.part || 0) + 1}.pdf`);

  currentModalContext = {
    gradeId,
    bookId,
    partNum,
    book,
    part,
    label,
    suggestedFileName,
    selectedFile: null,
    activeTab: 'upload'
  };

  const container = document.getElementById('pdf-modal-container');
  if (!container) return;

  const hasCurrentPdf = pdfInfo.hasPdf;

  container.innerHTML = `
    <div class="modal-overlay open" id="pdf-modal" onclick="handleModalOverlayClick(event)">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        
        <div class="modal-header">
          <div class="modal-header-titles">
            <div class="modal-header-icon">📕</div>
            <div>
              <h3 class="modal-title" id="modal-title">إضافة / تعديل ملف PDF</h3>
              <div class="modal-subtitle">${book.nameAr} — ${label} (${grade.nameAr})</div>
            </div>
          </div>
          <button class="modal-close-btn" onclick="closePdfModal()" aria-label="إغلاق">✕</button>
        </div>

        <div class="modal-body">
          
          <!-- Mode Tabs -->
          <div class="modal-tabs">
            <button class="modal-tab-btn active" id="tab-btn-upload" onclick="switchModalTab('upload')">
              📁 رفع ملف من الحاسوب
            </button>
            <button class="modal-tab-btn" id="tab-btn-url" onclick="switchModalTab('url')">
              🔗 رابط أو مسار ملف
            </button>
          </div>

          <!-- Tab 1: Upload File -->
          <div id="tab-content-upload">
            <div class="pdf-dropzone" id="pdf-dropzone" onclick="document.getElementById('modal-file-input').click()">
              <input type="file" id="modal-file-input" accept=".pdf" style="display:none" onchange="handleModalFileSelected(this)">
              <div class="pdf-dropzone-icon">📥</div>
              <div class="pdf-dropzone-text">اضغط هنا لاختيار ملف PDF من جهازك</div>
              <div class="pdf-dropzone-sub">أو اسحب وأفلت الملف داخل هذا المربع</div>
            </div>
            <div id="modal-file-preview" class="pdf-file-preview" style="display:none"></div>
          </div>

          <!-- Tab 2: URL / Path -->
          <div id="tab-content-url" style="display:none">
            <div class="modal-input-group">
              <label class="modal-section-title" for="modal-url-input">رابط مباشر (URL) أو مسار محلي:</label>
              <input type="text"
                     class="modal-input" 
                     id="modal-url-input" 
                     placeholder="مثال: pdf/${suggestedFileName} أو https://..."
                     value="${pdfInfo.type === 'url' ? pdfInfo.openUrl : (hasCurrentPdf && pdfInfo.type === 'default' ? pdfInfo.openUrl : '')}">
            </div>
          </div>

          <!-- Folder Helper Tip -->
          <div class="modal-tip-box">
            💡 <strong>الطريقة اليدوية في المجلد:</strong><br>
            يمكنك أيضاً نسخ ملف الـ PDF مباشرة إلى مجلد <code>schoolweb/pdf/</code> وتسميته:<br>
            <code style="user-select:all; cursor:pointer;" title="اضغط لنسخ اسم الملف" onclick="copySuggestedName('${suggestedFileName}')">pdf/${suggestedFileName} 📋</code>
          </div>

        </div>

        <div class="modal-footer">
          <div>
            ${hasCurrentPdf ? `
              <button class="btn-modal-delete" onclick="handleDeletePdfModal()" title="حذف الـ PDF من هذا الكتاب">
                🗑️ حذف الـ PDF
              </button>
            ` : ''}
          </div>
          <div class="modal-actions-right">
            <button class="btn-modal-cancel" onclick="closePdfModal()">إلغاء</button>
            <button class="btn-modal-save" onclick="handleSavePdfModal()">حفظ وتطبيق ✅</button>
          </div>
        </div>

      </div>
    </div>
  `;

  initDropzone();
}

function closePdfModal() {
  const modal = document.getElementById('pdf-modal');
  if (modal) {
    modal.classList.remove('open');
    setTimeout(() => {
      const container = document.getElementById('pdf-modal-container');
      if (container) container.innerHTML = '';
    }, 250);
  }
  currentModalContext = null;
}

function handleModalOverlayClick(e) {
  if (e.target && e.target.id === 'pdf-modal') {
    closePdfModal();
  }
}

function switchModalTab(tab) {
  if (!currentModalContext) return;
  currentModalContext.activeTab = tab;

  const btnUpload = document.getElementById('tab-btn-upload');
  const btnUrl = document.getElementById('tab-btn-url');
  const contentUpload = document.getElementById('tab-content-upload');
  const contentUrl = document.getElementById('tab-content-url');

  if (tab === 'upload') {
    btnUpload.classList.add('active');
    btnUrl.classList.remove('active');
    contentUpload.style.display = 'block';
    contentUrl.style.display = 'none';
  } else {
    btnUrl.classList.add('active');
    btnUpload.classList.remove('active');
    contentUrl.style.display = 'block';
    contentUpload.style.display = 'none';
    const inp = document.getElementById('modal-url-input');
    if (inp) inp.focus();
  }
}

function initDropzone() {
  const dropzone = document.getElementById('pdf-dropzone');
  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
        setModalSelectedFile(file);
      } else {
        showToast('يرجى اختيار ملف بصيغة PDF فقط ⚠️', 'info');
      }
    }
  });
}

function handleModalFileSelected(input) {
  if (input.files && input.files[0]) {
    setModalSelectedFile(input.files[0]);
  }
}

function setModalSelectedFile(file) {
  if (!currentModalContext) return;
  currentModalContext.selectedFile = file;

  const preview = document.getElementById('modal-file-preview');
  if (preview) {
    preview.style.display = 'flex';
    preview.innerHTML = `
      <div class="pdf-file-info">
        <span>📄</span>
        <span>${file.name}</span>
      </div>
      <div class="pdf-file-size">${formatBytes(file.size)} ✅</div>
    `;
  }
}

async function handleSavePdfModal() {
  if (!currentModalContext) return;
  const { gradeId, bookId, partNum, book, activeTab, selectedFile } = currentModalContext;

  if (activeTab === 'upload') {
    if (!selectedFile) {
      showToast('يرجى اختيار ملف PDF أولاً، أو التبديل لرابط ⚠️', 'info');
      return;
    }
    await PDFStorage.saveFile(bookId, partNum, selectedFile);
  } else {
    const inp = document.getElementById('modal-url-input');
    const url = inp ? inp.value.trim() : '';
    if (!url) {
      showToast('يرجى كتابة رابط أو مسار ملف الـ PDF ⚠️', 'info');
      return;
    }
    await PDFStorage.saveUrl(bookId, partNum, url);
  }

  closePdfModal();
  refreshGradeView(gradeId);
  showToast(`تم حفظ وتفعيل ملف PDF لـ "${book.nameAr}" بنجاح! 🎉`, 'success');
}

async function handleDeletePdfModal() {
  if (!currentModalContext) return;
  const { gradeId, bookId, partNum, book } = currentModalContext;

  await PDFStorage.removePdf(bookId, partNum);
  closePdfModal();
  refreshGradeView(gradeId);
  showToast(`تم حذف ملف الـ PDF من "${book.nameAr}"`, 'info');
}

function refreshGradeView(gradeId) {
  const grade = state.data.grades.find(g => g.id === gradeId);
  if (grade && state.currentGrade && state.currentGrade.id === gradeId) {
    renderGradePage(grade);
  }
}

function copySuggestedName(fileName) {
  const fullPath = `pdf/${fileName}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(fullPath).then(() => {
      showToast(`تم نسخ المسار: ${fullPath} 📋`, 'success');
    });
  } else {
    showToast(`المسار المقترح: ${fullPath}`, 'info');
  }
}

function exportDataJson() {
  if (!state.data) return;
  const reg = PDFStorage.getRegistry();
  const exported = JSON.parse(JSON.stringify(state.data));

  exported.grades.forEach(g => {
    delete g.mlazemnaUrl;
    g.books.forEach(b => {
      delete b.mlazemnaUrl;
      b.parts.forEach((p, idx) => {
        delete p.mlazemnaUrl;
        delete p.sourceSite;
        delete p.officialPortalUrl;
        delete p.fileSize;

        const partNum = typeof p.part === 'number' ? p.part : idx;
        const key = `${b.id}_p${partNum}`;
        const entry = reg[key];
        if (entry) {
          if (entry.type === 'url' && entry.url) {
            p.openUrl = entry.url;
            p.downloadUrl = entry.url;
          } else if (entry.type === 'file') {
            const path = `pdf/${p.suggestedFileName || entry.fileName}`;
            p.openUrl = path;
            p.downloadUrl = path;
          }
        }
      });
    });
  });

  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'data.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('تم تصدير ملف data.json المحدّث بنجاح! 📥', 'success');
}

function filterBookCards(query) {
  const grid = document.getElementById('books-grid');
  const empty = document.getElementById('books-empty');
  if (!grid) return;

  const q = query.trim().toLowerCase();
  const cards = grid.querySelectorAll('.book-card');
  let visible = 0;

  cards.forEach(card => {
    const name = (card.getAttribute('data-name') || '').toLowerCase();
    const match = !q || name.includes(q);
    card.style.display = match ? '' : 'none';
    if (match) visible++;
  });

  if (empty) empty.style.display = visible === 0 ? 'block' : 'none';
}

// =================== Search Logic ===================
function initSearch() {
  const searchInput = document.getElementById('global-search');
  if (!searchInput) return;

  let debounceTimer;
  searchInput.addEventListener('input', e => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => handleGlobalSearch(e.target.value), 180);
  });

  document.addEventListener('click', e => {
    const wrapper = document.getElementById('hero-search-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
      closeSearchResults();
    }
  });

  document.addEventListener('click', e => {
    if (e.target.id === 'search-clear-btn') {
      const inp = document.getElementById('global-search');
      if (inp) { inp.value = ''; handleGlobalSearch(''); }
    }
  });
}

function handleGlobalSearch(query) {
  const q = query.trim().toLowerCase();
  const clearBtn = document.getElementById('search-clear-btn');
  if (clearBtn) clearBtn.classList.toggle('visible', q.length > 0);

  if (!q || q.length < 2) { closeSearchResults(); return; }

  const results = [];
  state.data.grades.forEach(g => {
    g.books.forEach(b => {
      const subj = state.data.subjects[b.subject];
      if (b.nameAr.toLowerCase().includes(q) || (subj && subj.nameAr.toLowerCase().includes(q))) {
        b.parts.forEach(p => {
          results.push({ grade: g, book: b, part: p, subj });
        });
      }
    });
  });

  renderSearchResults(results);
}

function renderSearchResults(results) {
  const container = document.getElementById('search-results');
  if (!container) return;

  if (results.length === 0) {
    container.innerHTML = `<div class="search-no-results">لا توجد نتائج مطابقة 🔍</div>`;
    container.classList.add('open');
    return;
  }

  container.innerHTML = results.slice(0, 20).map(r => {
    let label = r.part.title;
    if (!label || label === r.book.nameAr) {
      label = r.part.part === 0 ? `${r.book.nameAr} (جزء واحد)`
        : `${r.book.nameAr} — ${r.part.part === 1 ? 'الجزء الأول' : 'الجزء الثاني'}`;
    }
    return `
      <div class="search-result-item" 
           onclick="navigateToGrade('${r.grade.id}')"
           role="option" tabindex="0"
           aria-label="${label} — ${r.grade.nameAr}">
        <span class="search-result-emoji">${r.subj ? r.subj.emoji : '📖'}</span>
        <div class="search-result-info">
          <div class="search-result-title">${label} <span class="search-pdf-tag">PDF</span></div>
          <div class="search-result-grade">${r.grade.nameAr}</div>
        </div>
        <span class="search-result-badge">${r.grade.shortName}</span>
      </div>
    `;
  }).join('');

  container.classList.add('open');
}

function closeSearchResults() {
  const container = document.getElementById('search-results');
  if (container) container.classList.remove('open');
}

// =================== Scroll Behavior ===================
function initScrollBehavior() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 20);
  }, { passive: true });
}

// =================== Helpers ===================
function getGradeEmoji(order) {
  const emojis = ['📗', '📘', '📙', '🔬', '🧪', '🎓'];
  return emojis[order - 1] || '📚';
}

function buildFooter() {
  return `
    <footer>
      <div class="footer-content">
        <div class="footer-brand">
          <div class="footer-logo">
            <span style="font-size:1.5rem">📚</span>
            <span class="footer-name">كتبي <span>العراق</span></span>
          </div>
          <p class="footer-desc">
            المكتبة الإلكترونية الشاملة للكتب والمناهج الدراسية العراقية للمرحلتين المتوسطة والإعدادية (الفرع العلمي)،
            وفق المنشورات الرسمية لوزارة التربية العراقية.
          </p>
        </div>
        <div class="footer-links">
          <a href="https://moedu.gov.iq/" target="_blank" rel="noopener">وزارة التربية العراقية الرسمية ↗</a>
          <a href="https://edup.moedu.gov.iq/" target="_blank" rel="noopener">البوابة التعليمية الإلكترونية ↗</a>
          <a href="#" onclick="navigateHome(); return false;">الصفحة الرئيسية</a>
          <a href="admin.html" class="footer-admin-pill" title="الدخول إلى لوحة إدارة المحتوى والمناهج">🔐 بوابة المشرف</a>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© 2025 منصة كتبي — جميع الحقوق محفوظة</span>
        <span class="footer-source-wrap">
          المصدر الرسمي: وزارة التربية العراقية
          <span class="footer-author">أنشئ بواسطة يقين محمد عطاالله</span>
        </span>
      </div>
    </footer>
  `;
}

// =================== Toast Notifications ===================
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✅' : 'ℹ️'}</span> <span class="toast-msg">${message}</span>`;
  toast.classList.add('show');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

function triggerDownloadToast(bookName) {
  showToast(`تم بدء حفظ وتحميل: ${bookName} بصيغة PDF 📕`, 'success');
}

// Keyboard accessibility for grade cards
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('grade-card')) {
    const onclick = e.target.getAttribute('onclick');
    if (onclick) eval(onclick);
  }
});