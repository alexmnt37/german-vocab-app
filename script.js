/* =============================================
   WORTSCHATZ — German Vocabulary Trainer
   v3 — Spaced Repetition System
   ============================================= */

// ─────────────────────────────────────────────
// 1. CONSTANTS & STORAGE
// ─────────────────────────────────────────────

const STORAGE_KEY = 'wortschatz_words';
const STATS_KEY   = 'wortschatz_stats';

// SRS interval table (milliseconds) by confidenceLevel 1–5.
// After a correct answer the word won't reappear until this window passes.
const SRS_INTERVALS = {
  1:  5  * 60 * 1000,            //  5 minutes
  2:  30 * 60 * 1000,            // 30 minutes
  3:  1  * 24 * 60 * 60 * 1000, //  1 day
  4:  3  * 24 * 60 * 60 * 1000, //  3 days
  5:  7  * 24 * 60 * 60 * 1000, //  7 days
};

// After a wrong answer the word is re-queued within this window
const WRONG_INTERVAL     = 5 * 60 * 1000;
const DAILY_SESSION_SIZE = 25;

function loadWords() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveWords(w) { localStorage.setItem(STORAGE_KEY, JSON.stringify(w)); }

function loadStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) || { correct: 0, wrong: 0 }; }
  catch { return { correct: 0, wrong: 0 }; }
}
function saveStats(s) { localStorage.setItem(STATS_KEY, JSON.stringify(s)); }

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─────────────────────────────────────────────
// 2. DATA MIGRATION
// Runs on startup. Adds new SRS fields to any
// existing words that don't have them yet,
// so old saved data works with the new system.
// ─────────────────────────────────────────────

function migrateWords(wordList) {
  let changed = false;
  wordList.forEach(w => {
    if (w.correctCount   === undefined) { w.correctCount    = w.timesCorrect || 0;  changed = true; }
    if (w.wrongCount     === undefined) { w.wrongCount      = w.timesWrong   || 0;  changed = true; }
    if (w.confidenceLevel=== undefined) { w.confidenceLevel = 1;                    changed = true; }
    if (w.lastReviewed   === undefined) { w.lastReviewed    = w.createdAt || Date.now(); changed = true; }
    if (w.nextReview     === undefined) { w.nextReview      = Date.now();           changed = true; }
    if (w.status         === undefined) {
      w.status = w.correctCount >= 4 ? 'mastered'
               : w.correctCount >= 1 ? 'learning'
               : 'new';
      changed = true;
    }
  });
  if (changed) saveWords(wordList);
  return wordList;
}

// ─────────────────────────────────────────────
// 3. SRS CORE
// ─────────────────────────────────────────────

// Default SRS values for a brand-new word
function freshSRS() {
  return {
    correctCount:    0,
    wrongCount:      0,
    confidenceLevel: 1,
    lastReviewed:    Date.now(),
    nextReview:      Date.now(), // due immediately
    status:          'new',
  };
}

// Update a word's SRS fields after it is answered.
// Called once per word per session.
function applySRS(word, correct) {
  const now = Date.now();
  word.lastReviewed = now;

  if (correct) {
    word.correctCount++;
    word.confidenceLevel = Math.min(word.confidenceLevel + 1, 5);
    word.nextReview      = now + SRS_INTERVALS[word.confidenceLevel];
    // Promote: mastered once confidence is 4 or 5
    word.status = word.confidenceLevel >= 4 ? 'mastered' : 'learning';
  } else {
    word.wrongCount++;
    word.confidenceLevel = Math.max(word.confidenceLevel - 1, 1);
    word.nextReview      = now + WRONG_INTERVAL;
    word.status          = 'learning'; // wrong always demotes from mastered
  }
}

// ─────────────────────────────────────────────
// 4. QUEUE BUILDERS
// ─────────────────────────────────────────────

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// DAILY — smart priority: new → overdue → due → mastered-due → rest
function buildDailyQueue(pool) {
  const now = Date.now();
  const buckets = {
    newWords:        pool.filter(w => w.status === 'new'),
    overdueLearning: pool.filter(w => w.status === 'learning' && w.nextReview <= now),
    dueNow:          [],
    masteredDue:     pool.filter(w => w.status === 'mastered' && w.nextReview <= now),
    notDue:          [],
  };
  // dueNow = everything overdue that isn't already in the first two buckets
  const covered = new Set([
    ...buckets.newWords, ...buckets.overdueLearning, ...buckets.masteredDue
  ]);
  pool.forEach(w => {
    if (!covered.has(w)) {
      if (w.nextReview <= now) buckets.dueNow.push(w);
      else                     buckets.notDue.push(w);
    }
  });
  const ordered = [
    ...shuffleArray(buckets.newWords),
    ...shuffleArray(buckets.overdueLearning),
    ...shuffleArray(buckets.dueNow),
    ...shuffleArray(buckets.masteredDue),
    ...shuffleArray(buckets.notDue),
  ];
  return ordered.slice(0, DAILY_SESSION_SIZE).map(w => w.id);
}

// FREE — category/difficulty filtered, wrong words appear more often
function buildFreeQueue(pool) {
  const queue = [];
  pool.forEach(w => {
    const extra = Math.max(0, w.wrongCount - w.correctCount);
    const reps  = Math.min(1 + extra, 4);
    for (let i = 0; i < reps; i++) queue.push(w.id);
  });
  return shuffleArray(queue);
}

// WEAK — sorted by lowest confidence, then highest wrong count
function buildWeakQueue(pool) {
  return pool
    .filter(w => w.status !== 'mastered' || w.confidenceLevel <= 2)
    .sort((a, b) =>
      a.confidenceLevel !== b.confidenceLevel
        ? a.confidenceLevel - b.confidenceLevel
        : b.wrongCount - a.wrongCount
    )
    .map(w => w.id);
}

// ─────────────────────────────────────────────
// 5. APP STATE
// ─────────────────────────────────────────────

let words       = migrateWords(loadWords());
let currentCat  = 'nouns';
let selectedArt = '';

let session = {
  queue:       [],
  index:       0,
  correct:     0,
  wrong:       0,
  streak:      0,
  answered:    false,
  currentWord: null,
  mode:        'free', // 'daily' | 'free' | 'weak'
};

// ─────────────────────────────────────────────
// 6. DOM REFERENCES
// ─────────────────────────────────────────────

const tabBtns        = document.querySelectorAll('.bnav-btn');
const libraryScreen  = document.getElementById('libraryScreen');
const practiceScreen = document.getElementById('practiceScreen');
const catBtns        = document.querySelectorAll('.cat-btn');
const countEls       = {
  nouns: document.getElementById('countNouns'),
  verbs: document.getElementById('countVerbs'),
  other: document.getElementById('countOther'),
};

const btnToggleAdd = document.getElementById('btnToggleAdd');
const addForm      = document.getElementById('addForm');
const formTitle    = document.getElementById('formTitle');
const fRomanian    = document.getElementById('fRomanian');
const fGerman      = document.getElementById('fGerman');
const fArticle     = document.getElementById('fArticle');
const fPlural      = document.getElementById('fPlural');
const fDifficulty  = document.getElementById('fDifficulty');
const nounFields   = document.querySelector('.noun-fields');
const artBtns      = document.querySelectorAll('.art-btn');
const btnSaveWord  = document.getElementById('btnSaveWord');
const btnCancelAdd = document.getElementById('btnCancelAdd');

const wordList    = document.getElementById('wordList');
const listLabel   = document.getElementById('listLabel');
const searchInput = document.getElementById('searchInput');
const filterDiff  = document.getElementById('filterDifficulty');
const filterStatus= document.getElementById('filterStatus');
const headerStats = document.getElementById('headerStats');
const srsProgress = document.getElementById('srsProgress');

const practiceSetup     = document.getElementById('practiceSetup');
const practiceCard      = document.getElementById('practiceCard');
const sessionSummary    = document.getElementById('sessionSummary');
const btnStartPractice  = document.getElementById('btnStartPractice');
const btnStartDaily     = document.getElementById('btnStartDaily');
const btnStartWeak      = document.getElementById('btnStartWeak');
const dailyCountBadge   = document.getElementById('dailyCountBadge');
const sessionModeLabel  = document.getElementById('sessionModeLabel');

const progressBar    = document.getElementById('progressBar');
const progressLabel  = document.getElementById('progressLabel');
const scoreCorrect   = document.getElementById('scoreCorrect');
const scoreWrong     = document.getElementById('scoreWrong');
const scoreStreak    = document.getElementById('scoreStreak');
const wordStatusBadge= document.getElementById('wordStatusBadge');
const questionMeta   = document.getElementById('questionMeta');
const questionPrompt = document.getElementById('questionPrompt');
const questionHint   = document.getElementById('questionHint');
const answerArea     = document.getElementById('answerArea');

const nounFeedback  = document.getElementById('nounFeedback');
const nfTranslation = document.getElementById('nfTranslation');
const nfArticle     = document.getElementById('nfArticle');
const nfPlural      = document.getElementById('nfPlural');

const feedbackArea    = document.getElementById('feedbackArea');
const feedbackMessage = document.getElementById('feedbackMessage');
const feedbackCorrect = document.getElementById('feedbackCorrect');

const btnCheck = document.getElementById('btnCheck');
const btnNext  = document.getElementById('btnNext');
const btnSkip  = document.getElementById('btnSkip');

const sumCorrect      = document.getElementById('sumCorrect');
const sumWrong        = document.getElementById('sumWrong');
const sumAccuracy     = document.getElementById('sumAccuracy');
const summaryMessage  = document.getElementById('summaryMessage');
const btnPracticeAgain= document.getElementById('btnPracticeAgain');
const btnBackToSetup  = document.getElementById('btnBackToSetup');

// ─────────────────────────────────────────────
// 7. NAVIGATION
// ─────────────────────────────────────────────

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    libraryScreen.classList.remove('active');
    practiceScreen.classList.remove('active');
    document.getElementById(btn.dataset.tab + 'Screen').classList.add('active');
    if (btn.dataset.tab === 'practice') updateDailyBadge();
  });
});

catBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    catBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentCat = btn.dataset.cat;
    updateFormForCategory();
    renderWordList();
  });
});

// ─────────────────────────────────────────────
// 8. ADD WORD FORM
// ─────────────────────────────────────────────

btnToggleAdd.addEventListener('click', () => {
  addForm.classList.toggle('hidden');
  btnToggleAdd.textContent = addForm.classList.contains('hidden') ? '+ Add Word' : '− Close Form';
  resetForm();
});

btnCancelAdd.addEventListener('click', () => {
  addForm.classList.add('hidden');
  btnToggleAdd.textContent = '+ Add Word';
  resetForm();
});

function updateFormForCategory() {
  const labels = { nouns: 'Add Noun', verbs: 'Add Verb', other: 'Add Expression' };
  formTitle.textContent = labels[currentCat];
  nounFields.style.display = currentCat === 'nouns' ? 'block' : 'none';
}

artBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    artBtns.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedArt    = btn.dataset.art;
    fArticle.value = selectedArt;
  });
});

btnSaveWord.addEventListener('click', () => {
  const ro = fRomanian.value.trim();
  const de = fGerman.value.trim();
  if (!ro || !de) { alert('Please fill in both Romanian and German fields.'); return; }
  if (currentCat === 'nouns' && !fArticle.value) { alert('Please select an article (der/die/das).'); return; }

  const word = {
    id:           genId(),
    category:     currentCat,
    romanian:     ro,
    german:       de,
    article:      currentCat === 'nouns' ? fArticle.value : '',
    plural:       currentCat === 'nouns' ? fPlural.value.trim() : '',
    difficulty:   fDifficulty.value,
    timesCorrect: 0,
    timesWrong:   0,
    createdAt:    Date.now(),
    ...freshSRS(),
  };

  words.push(word);
  saveWords(words);
  resetForm();
  renderWordList();
  updateCounts();
  updateHeaderStats();
  updateSRSProgress();
  updateDailyBadge();

  wordList.style.opacity = '0.5';
  setTimeout(() => { wordList.style.opacity = '1'; }, 150);
});

function resetForm() {
  fRomanian.value = '';
  fGerman.value   = '';
  fArticle.value  = '';
  fPlural.value   = '';
  selectedArt     = '';
  fDifficulty.value = 'medium';
  artBtns.forEach(b => b.classList.remove('selected'));
  updateFormForCategory();
}

// ─────────────────────────────────────────────
// 9. WORD LIST RENDERING
// ─────────────────────────────────────────────

function renderWordList() {
  const search = searchInput.value.toLowerCase();
  const diff   = filterDiff.value;
  const status = filterStatus ? filterStatus.value : '';
  const labels = { nouns: 'Nouns', verbs: 'Verbs', other: 'Expressions' };
  listLabel.textContent = `All ${labels[currentCat]}`;

  const filtered = words.filter(w => {
    if (w.category !== currentCat)           return false;
    if (diff   && w.difficulty !== diff)     return false;
    if (status && w.status     !== status)   return false;
    if (search) {
      const hay = (w.romanian + w.german + (w.article || '') + (w.plural || '')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    wordList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📖</div>
        No words yet. Use "Add Word" to get started!
      </div>`;
    return;
  }

  wordList.innerHTML = filtered.map(w => {
    const total    = w.correctCount + w.wrongCount;
    const accuracy = total > 0 ? Math.round(w.correctCount / total * 100) + '%' : '—';
    const deDisplay = w.category === 'nouns'
      ? `<span class="word-article">${w.article}</span> ${escHtml(w.german)}`
      : escHtml(w.german);
    const pluralLine = w.plural ? `<div class="word-plural">Pl: ${escHtml(w.plural)}</div>` : '';

    // 5 confidence dots, filled up to confidenceLevel
    const dots = [1,2,3,4,5].map(i =>
      `<span class="conf-dot ${i <= w.confidenceLevel ? 'filled' : ''}"></span>`
    ).join('');

    return `
      <div class="word-card" data-id="${w.id}">
        <div class="word-card-left">
          <div class="word-ro">${escHtml(w.romanian)}</div>
          <div class="word-de">${deDisplay}</div>
          ${pluralLine}
        </div>
        <div class="word-card-right">
          <span class="status-badge status-${w.status}">${w.status}</span>
          <span class="diff-badge diff-${w.difficulty}">${w.difficulty}</span>
          <span class="word-stats">${accuracy}</span>
          <div class="conf-dots" title="Confidence ${w.confidenceLevel}/5">${dots}</div>
          <button class="btn-reset-word" data-id="${w.id}" title="Reset progress">&#8635;</button>
          <button class="btn-delete"     data-id="${w.id}" title="Delete">&#215;</button>
        </div>
      </div>`;
  }).join('');

  wordList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('Delete this word?')) {
        words = words.filter(w => w.id !== btn.dataset.id);
        saveWords(words);
        renderWordList(); updateCounts(); updateHeaderStats(); updateSRSProgress(); updateDailyBadge();
      }
    });
  });

  // Reset per-word progress back to fresh SRS state
  wordList.querySelectorAll('.btn-reset-word').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('Reset all progress for this word?')) {
        const w = words.find(w => w.id === btn.dataset.id);
        if (w) {
          Object.assign(w, freshSRS());
          w.timesCorrect = 0;
          w.timesWrong   = 0;
          saveWords(words);
          renderWordList(); updateSRSProgress(); updateDailyBadge();
        }
      }
    });
  });
}

function updateCounts() {
  countEls.nouns.textContent = words.filter(w => w.category === 'nouns').length;
  countEls.verbs.textContent = words.filter(w => w.category === 'verbs').length;
  countEls.other.textContent = words.filter(w => w.category === 'other').length;
}

function updateHeaderStats() {
  const stats    = loadStats();
  const mastered = words.filter(w => w.status === 'mastered').length;
  const accuracy = (stats.correct + stats.wrong) > 0
    ? Math.round(stats.correct / (stats.correct + stats.wrong) * 100) : 0;
  headerStats.innerHTML = `
    <div class="hstat"><strong>${words.length}</strong>words</div>
    <div class="hstat"><strong>${mastered}</strong>mastered</div>
    <div class="hstat"><strong>${accuracy}%</strong>accuracy</div>`;
}

// SRS stacked progress bar in the library header
function updateSRSProgress() {
  if (!srsProgress) return;
  const total    = words.length;
  const mastered = words.filter(w => w.status === 'mastered').length;
  const learning = words.filter(w => w.status === 'learning').length;
  const newW     = words.filter(w => w.status === 'new').length;
  const pM = total > 0 ? Math.round(mastered / total * 100) : 0;
  const pL = total > 0 ? Math.round(learning / total * 100) : 0;
  const pN = total > 0 ? Math.round(newW     / total * 100) : 0;
  srsProgress.innerHTML = `
    <div class="srs-bar-row">
      <div class="srs-bar-wrap">
        <div class="srs-seg srs-mastered" style="width:${pM}%" title="${mastered} mastered"></div>
        <div class="srs-seg srs-learning" style="width:${pL}%" title="${learning} learning"></div>
        <div class="srs-seg srs-new"      style="width:${pN}%" title="${newW} new"></div>
      </div>
    </div>
    <div class="srs-legend">
      <span class="srs-leg-item"><span class="srs-dot srs-mastered"></span>${mastered} mastered</span>
      <span class="srs-leg-item"><span class="srs-dot srs-learning"></span>${learning} learning</span>
      <span class="srs-leg-item"><span class="srs-dot srs-new"     ></span>${newW} new</span>
    </div>`;
}

// Count words due right now (for the Daily badge on the Practice tab)
function countDueWords() {
  const now = Date.now();
  return words.filter(w => w.status === 'new' || w.nextReview <= now).length;
}

function updateDailyBadge() {
  if (!dailyCountBadge) return;
  const due = countDueWords();
  dailyCountBadge.textContent = due > 0 ? `${due} due` : 'up to date';
  dailyCountBadge.className   = `daily-badge ${due > 0 ? 'has-due' : 'all-done'}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

searchInput.addEventListener('input',  renderWordList);
filterDiff.addEventListener('change',  renderWordList);
if (filterStatus) filterStatus.addEventListener('change', renderWordList);

// ─────────────────────────────────────────────
// 10. PRACTICE SETUP — three mode buttons
// ─────────────────────────────────────────────

function buildPool(cat, diff) {
  return words.filter(w => {
    if (cat !== 'all' && w.category !== cat) return false;
    if (diff && w.difficulty !== diff)       return false;
    return true;
  });
}

function startSession(queue, mode) {
  if (queue.length === 0) { alert('No words to practice!'); return; }
  session = { queue, index: 0, correct: 0, wrong: 0, streak: 0, answered: false, currentWord: null, mode };
  practiceSetup.classList.add('hidden');
  sessionSummary.classList.add('hidden');
  practiceCard.classList.remove('hidden');
  const labels = { daily: 'Daily Practice', free: 'Free Practice', weak: 'Weak Words' };
  if (sessionModeLabel) sessionModeLabel.textContent = labels[mode] || '';
  showNextQuestion();
}

btnStartDaily.addEventListener('click', () => {
  const cat  = document.querySelector('input[name="practiceCat"]:checked').value;
  const diff = document.querySelector('input[name="practiceDiff"]:checked').value;
  const pool = buildPool(cat, diff);
  if (!pool.length) { alert('No words found for those settings.'); return; }
  startSession(buildDailyQueue(pool), 'daily');
});

btnStartPractice.addEventListener('click', () => {
  const cat  = document.querySelector('input[name="practiceCat"]:checked').value;
  const diff = document.querySelector('input[name="practiceDiff"]:checked').value;
  const pool = buildPool(cat, diff);
  if (!pool.length) { alert('No words found for those settings.'); return; }
  startSession(buildFreeQueue(pool), 'free');
});

btnStartWeak.addEventListener('click', () => {
  const cat  = document.querySelector('input[name="practiceCat"]:checked').value;
  const diff = document.querySelector('input[name="practiceDiff"]:checked').value;
  const pool = buildPool(cat, diff);
  const q    = buildWeakQueue(pool);
  if (!q.length) { alert('No weak words found — great job!'); return; }
  startSession(q, 'weak');
});

// ─────────────────────────────────────────────
// 11. QUESTION RENDERING
// ─────────────────────────────────────────────

function showNextQuestion() {
  if (session.index >= session.queue.length) { endSession(); return; }

  const word = words.find(w => w.id === session.queue[session.index]);
  if (!word) { session.index++; showNextQuestion(); return; }

  session.currentWord = word;
  session.answered    = false;

  const pct = Math.round((session.index / session.queue.length) * 100);
  progressBar.style.width   = pct + '%';
  progressLabel.textContent = `${session.index + 1} / ${session.queue.length}`;

  // Show the word's current SRS status as a small badge
  if (wordStatusBadge) {
    wordStatusBadge.textContent = word.status;
    wordStatusBadge.className   = `word-status-badge status-${word.status}`;
  }

  updateScoreDisplay();
  nounFeedback.classList.add('hidden');
  feedbackArea.classList.add('hidden');
  btnCheck.classList.remove('hidden');
  btnNext.classList.add('hidden');
  btnSkip.classList.remove('hidden');

  if (word.category === 'nouns') renderNounQuestion(word);
  else                           renderSimpleQuestion(word);
}

function renderNounQuestion(w) {
  questionMeta.textContent   = 'Substantiv — translate + article + plural';
  questionPrompt.textContent = w.romanian;
  questionHint.textContent   = 'Fill in all three fields, then press Check Answers';

  answerArea.innerHTML = `
    <div>
      <div class="field-label">German noun</div>
      <input type="text" id="inputGerman"
             placeholder="e.g. Haus"
             autocomplete="off" autocorrect="off" spellcheck="false" />
    </div>
    <div>
      <div class="field-label">Article</div>
      <div class="article-choice-btns" id="articleBtns">
        <button type="button" data-art="der">der</button>
        <button type="button" data-art="die">die</button>
        <button type="button" data-art="das">das</button>
      </div>
    </div>
    <div>
      <div class="field-label">Plural form</div>
      <input type="text" id="inputPlural"
             placeholder="e.g. H&#228;user"
             autocomplete="off" autocorrect="off" spellcheck="false" />
    </div>
  `;

  document.querySelectorAll('#articleBtns button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#articleBtns button').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      answerArea.dataset.selectedArticle = btn.dataset.art;
    });
  });

  ['inputGerman','inputPlural'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !session.answered) checkNounAnswers();
    });
  });

  setTimeout(() => document.getElementById('inputGerman')?.focus(), 50);
}

function renderSimpleQuestion(w) {
  const isVerb = w.category === 'verbs';
  questionMeta.textContent   = isVerb ? 'Verb &#8594; Infinitive' : 'Expression';
  questionPrompt.textContent = w.romanian;
  questionHint.textContent   = `Type the German ${isVerb ? 'infinitive' : 'translation'}`;

  answerArea.innerHTML = `
    <input type="text" id="inputGerman"
           placeholder="German translation&#8230;"
           autocomplete="off" autocorrect="off" spellcheck="false" />
  `;

  document.getElementById('inputGerman')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !session.answered) checkSimpleAnswer();
  });

  setTimeout(() => document.getElementById('inputGerman')?.focus(), 50);
}

// ─────────────────────────────────────────────
// 12. ANSWER CHECKING
// ─────────────────────────────────────────────

function normalize(str) {
  return (str || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function makeFeedbackRow(correct, label, correctValue) {
  const row  = document.createElement('div');
  row.className = `nf-row ${correct ? 'nf-ok' : 'nf-bad'}`;
  const icon = document.createElement('span');
  icon.textContent = correct ? '✓' : '✗';
  const text = document.createElement('span');
  text.textContent = label;
  row.appendChild(icon);
  row.appendChild(text);
  if (!correct && correctValue) {
    const fix = document.createElement('span');
    fix.className   = 'nf-correction';
    fix.textContent = `→ ${correctValue}`;
    row.appendChild(fix);
  }
  return row;
}

function checkNounAnswers() {
  if (session.answered) return;
  session.answered = true;
  btnCheck.classList.add('hidden');
  btnSkip.classList.add('hidden');

  const w           = session.currentWord;
  const germanInput = document.getElementById('inputGerman');
  const pluralInput = document.getElementById('inputPlural');
  const chosenArt   = answerArea.dataset.selectedArticle || '';
  const germanVal   = germanInput?.value.trim() || '';
  const pluralVal   = pluralInput?.value.trim() || '';

  const germanOk  = normalize(germanVal) === normalize(w.german);
  const articleOk = chosenArt === w.article;
  const pluralOk  = !w.plural ? true : normalize(pluralVal) === normalize(w.plural);

  if (germanInput) germanInput.classList.add(germanOk  ? 'correct-input' : 'wrong-input');
  if (pluralInput) pluralInput.classList.add(pluralOk  ? 'correct-input' : 'wrong-input');

  document.querySelectorAll('#articleBtns button').forEach(btn => {
    const art = btn.dataset.art;
    if (art === w.article && articleOk)  btn.classList.add('art-correct');
    if (art === chosenArt && !articleOk) btn.classList.add('art-wrong');
    if (art === w.article && !articleOk) btn.classList.add('art-reveal');
    btn.disabled = true;
  });

  nfTranslation.innerHTML = '';
  nfArticle.innerHTML     = '';
  nfPlural.innerHTML      = '';

  nfTranslation.appendChild(makeFeedbackRow(germanOk,
    `Noun: ${germanOk ? germanVal : germanVal || '(blank)'}`, w.german));
  nfArticle.appendChild(makeFeedbackRow(articleOk,
    `Article: ${chosenArt || '(none selected)'}`, w.article));
  if (w.plural) {
    nfPlural.appendChild(makeFeedbackRow(pluralOk,
      `Plural: ${pluralOk ? pluralVal : pluralVal || '(blank)'}`, w.plural));
  } else {
    nfPlural.appendChild(makeFeedbackRow(true, 'Plural: (no plural form)', ''));
  }

  nounFeedback.classList.remove('hidden');
  recordResult(w.id, germanOk && articleOk && pluralOk);
  btnNext.classList.remove('hidden');
}

function checkSimpleAnswer() {
  if (session.answered) return;
  session.answered = true;
  btnCheck.classList.add('hidden');
  btnSkip.classList.add('hidden');

  const w      = session.currentWord;
  const inp    = document.getElementById('inputGerman');
  const answer = inp?.value.trim() || '';
  const correct = normalize(answer) === normalize(w.german);

  if (inp) inp.classList.add(correct ? 'correct-input' : 'wrong-input');

  feedbackMessage.textContent = correct ? '✓ Correct!' : '✗ Wrong';
  feedbackMessage.className   = `feedback-message ${correct ? 'ok' : 'bad'}`;
  feedbackCorrect.textContent = correct ? '' : `Correct answer: ${w.german}`;
  feedbackArea.classList.remove('hidden');

  recordResult(w.id, correct);
  btnNext.classList.remove('hidden');
}

// Core result handler — updates session score, SRS fields, and persisted stats
function recordResult(wordId, correct) {
  if (correct) { session.correct++; session.streak++; }
  else         { session.wrong++;   session.streak = 0; }
  updateScoreDisplay();

  const w = words.find(w => w.id === wordId);
  if (w) {
    // Keep legacy fields in sync for export compatibility
    if (correct) w.timesCorrect = (w.timesCorrect || 0) + 1;
    else         w.timesWrong   = (w.timesWrong   || 0) + 1;
    applySRS(w, correct);
    saveWords(words);
  }

  const ls = loadStats();
  if (correct) ls.correct++; else ls.wrong++;
  saveStats(ls);
  updateHeaderStats();
  updateSRSProgress();
}

// ─────────────────────────────────────────────
// 13. PRACTICE NAVIGATION
// ─────────────────────────────────────────────

btnCheck.addEventListener('click', () => {
  if (session.answered) return;
  const w = session.currentWord;
  if (w.category === 'nouns') checkNounAnswers();
  else                        checkSimpleAnswer();
});

btnNext.addEventListener('click', () => { session.index++; showNextQuestion(); });
btnSkip.addEventListener('click', () => { session.index++; showNextQuestion(); });

function updateScoreDisplay() {
  scoreCorrect.textContent = `✓ ${session.correct}`;
  scoreWrong.textContent   = `✗ ${session.wrong}`;
  scoreStreak.textContent  = `🔥 ${session.streak}`;
}

// ─────────────────────────────────────────────
// 14. SESSION END
// ─────────────────────────────────────────────

function endSession() {
  practiceCard.classList.add('hidden');
  sessionSummary.classList.remove('hidden');

  const total    = session.correct + session.wrong;
  const accuracy = total > 0 ? Math.round(session.correct / total * 100) : 0;

  sumCorrect.textContent  = session.correct;
  sumWrong.textContent    = session.wrong;
  sumAccuracy.textContent = accuracy + '%';

  const sumMastered = document.getElementById('sumMastered');
  if (sumMastered) sumMastered.textContent = words.filter(w => w.status === 'mastered').length;

  let msg = '';
  if (total === 0)         msg = 'You skipped everything! Try to answer next time.';
  else if (accuracy >= 90) msg = 'Ausgezeichnet! Excellent work! 🎉';
  else if (accuracy >= 70) msg = 'Sehr gut! Keep it up!';
  else if (accuracy >= 50) msg = 'Gut! Review the tricky ones and try again.';
  else                     msg = 'Keep practicing — repetition is the key to mastery!';
  summaryMessage.textContent = msg;

  updateDailyBadge();
}

btnPracticeAgain.addEventListener('click', () => {
  sessionSummary.classList.add('hidden');
  practiceCard.classList.remove('hidden');
  const map = { daily: btnStartDaily, weak: btnStartWeak, free: btnStartPractice };
  (map[session.mode] || btnStartPractice).click();
});

btnBackToSetup.addEventListener('click', () => {
  sessionSummary.classList.add('hidden');
  practiceSetup.classList.remove('hidden');
});

// ─────────────────────────────────────────────
// 15. EXPORT / IMPORT
// ─────────────────────────────────────────────

// A flag stored in localStorage that marks "the user has real data".
// When this is set, seedIfEmpty() will never overwrite the word list.
const SEEDED_KEY = 'wortschatz_seeded';

document.getElementById('btnExport').addEventListener('click', () => {
  const backup = { exportedAt: new Date().toISOString(), version: 2, stats: loadStats(), words };
  const blob   = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href       = url;
  a.download   = `wortschatz-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Step 1: clicking Import opens the file picker ──
document.getElementById('btnImport').addEventListener('click', () => {
  document.getElementById('importFileInput').click();
});

// ── Step 2: once a file is chosen, validate it first,
//    then show the Replace / Merge modal ──
document.getElementById('importFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = ev => {
    // Always reset the input so the same file can be re-selected later
    e.target.value = '';

    // ── Validate ──
    let backup;
    try {
      backup = JSON.parse(ev.target.result);
    } catch {
      showToast('Could not read file — is it valid JSON?', 'bad');
      return;
    }

    if (!backup.words || !Array.isArray(backup.words)) {
      showToast('Invalid file — no word list found.', 'bad');
      return;
    }

    const required = ['id', 'category', 'romanian', 'german'];
    if (!backup.words.every(w => required.every(f => f in w))) {
      showToast('File contains invalid word entries.', 'bad');
      return;
    }

    if (backup.words.length === 0) {
      showToast('The backup file contains no words.', 'bad');
      return;
    }

    // ── File is valid — show the modal ──
    showImportModal(backup);
  };

  reader.readAsText(file);
});

// ── Show the Replace / Merge modal ──
// Stores the parsed backup on the modal element so the choice handlers can read it.
function showImportModal(backup) {
  const modal = document.getElementById('importModal');
  const body  = document.getElementById('importModalBody');

  body.textContent =
    `"${backup.exportedAt ? new Date(backup.exportedAt).toLocaleDateString() : 'unknown date'}" — ` +
    `${backup.words.length} word${backup.words.length !== 1 ? 's' : ''} found. ` +
    `What would you like to do?`;

  // Attach the backup data to the modal so the buttons can use it
  modal._pendingBackup = backup;
  modal.classList.remove('hidden');
}

function closeImportModal() {
  const modal = document.getElementById('importModal');
  modal.classList.add('hidden');
  modal._pendingBackup = null;
}

// ── REPLACE: wipe everything, load only the imported data ──
document.getElementById('btnImportReplace').addEventListener('click', () => {
  const modal  = document.getElementById('importModal');
  const backup = modal._pendingBackup;
  if (!backup) return;
  closeImportModal();

  // Sanitize: ensure every imported word has all SRS fields
  const sanitized = migrateWords(backup.words.map(w => ({
    timesCorrect: 0, timesWrong: 0, createdAt: Date.now(), ...w,
  })));

  // Overwrite everything
  words = sanitized;
  saveWords(words);

  // Mark that real data now exists so seedIfEmpty() never fires again
  localStorage.setItem(SEEDED_KEY, '1');

  // Restore stats from backup if present
  if (backup.stats) saveStats(backup.stats);

  refreshAll();
  showToast(`Replaced: ${sanitized.length} word${sanitized.length !== 1 ? 's' : ''} loaded.`, 'ok');
});

// ── MERGE: keep existing words, add only those not already present ──
// Duplicate detection uses the Romanian+German pair (not just ID),
// so words from a different device/session that have different IDs
// but identical content are still treated as duplicates.
document.getElementById('btnImportMerge').addEventListener('click', () => {
  const modal  = document.getElementById('importModal');
  const backup = modal._pendingBackup;
  if (!backup) return;
  closeImportModal();

  // Build a set of "romanian|german" keys for every word already in the list
  const existingPairs = new Set(
    words.map(w => `${w.romanian.trim().toLowerCase()}|${w.german.trim().toLowerCase()}`)
  );

  // Also track existing IDs to skip exact ID duplicates
  const existingIds = new Set(words.map(w => w.id));

  const incoming = backup.words.filter(w => {
    // Skip if ID already exists
    if (existingIds.has(w.id)) return false;
    // Skip if Romanian+German pair already exists
    const pair = `${w.romanian.trim().toLowerCase()}|${w.german.trim().toLowerCase()}`;
    if (existingPairs.has(pair)) return false;
    return true;
  });

  const skipped   = backup.words.length - incoming.length;
  const sanitized = migrateWords(incoming.map(w => ({
    timesCorrect: 0, timesWrong: 0, createdAt: Date.now(), ...w,
  })));

  words = [...words, ...sanitized];
  saveWords(words);
  localStorage.setItem(SEEDED_KEY, '1');

  refreshAll();
  let msg = `Merged: ${sanitized.length} word${sanitized.length !== 1 ? 's' : ''} added`;
  if (skipped > 0) msg += ` (${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped)`;
  showToast(msg, 'ok');
});

// Cancel just closes the modal, file is already cleared above
document.getElementById('btnImportCancel').addEventListener('click', closeImportModal);

// Close modal when clicking the backdrop
document.getElementById('importModal').addEventListener('click', e => {
  if (e.target === document.getElementById('importModal')) closeImportModal();
});

// Shared UI refresh helper
function refreshAll() {
  renderWordList();
  updateCounts();
  updateHeaderStats();
  updateSRSProgress();
  updateDailyBadge();
}

function showToast(msg, type) {
  const old = document.querySelector('.import-toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className   = `import-toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─────────────────────────────────────────────
// 16. SEED DATA
// Only runs when the app has never had real data.
// Once any real data exists (or has been imported),
// the SEEDED_KEY flag prevents this from running again.
// ─────────────────────────────────────────────

function seedIfEmpty() {
  // If real data already exists, never seed
  if (words.length > 0) {
    localStorage.setItem(SEEDED_KEY, '1');
    return;
  }
  // If the flag is set but words array is empty, someone cleared their
  // data intentionally — respect that, don't re-add samples
  if (localStorage.getItem(SEEDED_KEY)) return;

  const seed = [
    { category:'nouns', romanian:'casă',       german:'Haus',            article:'das', plural:'Häuser',          difficulty:'easy'   },
    { category:'nouns', romanian:'mașină',      german:'Auto',            article:'das', plural:'Autos',           difficulty:'easy'   },
    { category:'nouns', romanian:'câine',       german:'Hund',            article:'der', plural:'Hunde',           difficulty:'easy'   },
    { category:'nouns', romanian:'carte',       german:'Buch',            article:'das', plural:'Bücher',          difficulty:'easy'   },
    { category:'nouns', romanian:'fereastră',   german:'Fenster',         article:'das', plural:'Fenster',         difficulty:'medium' },
    { category:'nouns', romanian:'orașul',      german:'Stadt',           article:'die', plural:'Städte',          difficulty:'medium' },
    { category:'verbs', romanian:'a merge',     german:'gehen',           article:'',    plural:'',                difficulty:'easy'   },
    { category:'verbs', romanian:'a mânca',     german:'essen',           article:'',    plural:'',                difficulty:'easy'   },
    { category:'verbs', romanian:'a vorbi',     german:'sprechen',        article:'',    plural:'',                difficulty:'medium' },
    { category:'other', romanian:'Bună ziua',   german:'Guten Tag',       article:'',    plural:'',                difficulty:'easy'   },
    { category:'other', romanian:'Mulțumesc',   german:'Danke',           article:'',    plural:'',                difficulty:'easy'   },
    { category:'other', romanian:'La revedere', german:'Auf Wiedersehen', article:'',    plural:'',                difficulty:'easy'   },
  ].map(w => ({ id:genId(), ...w, timesCorrect:0, timesWrong:0, createdAt:Date.now(), ...freshSRS() }));

  words = seed;
  saveWords(words);
  // Do NOT set SEEDED_KEY here — sample data is not "real" data.
  // This allows a Replace import to cleanly overwrite samples.
}

// ─────────────────────────────────────────────
// 17. INIT
// ─────────────────────────────────────────────

function init() {
  seedIfEmpty();
  updateFormForCategory();
  renderWordList();
  updateCounts();
  updateHeaderStats();
  updateSRSProgress();
  updateDailyBadge();
}

init();

// ─────────────────────────────────────────────
// 18. PWA — Service Worker Registration
// Registers the service worker so the app works
// offline and can be installed to the home screen.
// ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .catch(err => console.warn('SW registration failed:', err));
  });
}
