/**
 * gtdFilters.js — TaskForge-style GTD filter engine + taxonomy.
 *
 * Dependency-free ES module. A "task" is a Note with note_type === "task".
 * This module owns:
 *   - the GTD taxonomy (statuses, contexts, tag groups)
 *   - the filter field / operator catalog
 *   - a pure client-side evaluator (evaluateGroup / evaluateCondition)
 *   - applyView(notes, view) → filtered + sorted task array
 *   - matrixBucket(note) for the Eisenhower (Q1–Q4) view
 *   - defaultGtdViews() — the 8 seed smart-lists
 *
 * Saved views are persisted by notes.js to /api/prefs/gtd_views.
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export const STATUSES = [
  { code: 'todo',    label: 'To Do' },
  { code: 'blocked', label: 'Blocked' },   // → Waiting For
  { code: 'someday', label: 'Someday' },
  { code: 'done',    label: 'Done' },
];

export const STATUS_LABELS = STATUSES.reduce((m, s) => { m[s.code] = s.label; return m; }, {});

export const CONTEXTS = ['@Desk', '@Home', '@Phone', '@Errands', '@Anywhere', '@Meeting'];

export const TAG_GROUPS = [
  { name: 'Priority',    tags: ['#q1', '#q2', '#q3', '#q4'] },
  { name: 'Duration',    tags: ['#2min', '#5min', '#10min', '#15min', '#20min', '#30min', '#60min', '#90min', '#half-day'] },
  { name: 'Energy',      tags: ['#deep', '#shallow'] },
  { name: 'Work Area',   tags: ['#futurama', '#pixfra', '#pulsar', '#coffee-cars', '#content', '#side-biz', '#personal'] },
  { name: 'Department',  tags: ['#sales', '#marketing', '#accounts', '#procurement', '#logistics', '#repairs', '#catalogue', '#store-team'] },
  { name: 'Action Type', tags: ['#waiting', '#review', '#decision', '#delegate'] },
];

export const ALL_TAGS = TAG_GROUPS.reduce((a, g) => a.concat(g.tags), []);

// ---------------------------------------------------------------------------
// Field / operator catalog
// ---------------------------------------------------------------------------

// type drives which operators are offered and how values are matched/edited.
//   status     — exact code match (gtd_status)
//   membership — space-separated token set (contexts, tags)
//   text       — free string
//   date       — ISO date string (date-only comparison)
export const FIELDS = {
  status:         { label: 'Status',         type: 'status',     key: 'gtd_status' },
  contexts:       { label: 'Contexts',       type: 'membership', key: 'contexts' },
  tags:           { label: 'Tags',           type: 'membership', key: 'label' },
  project:        { label: 'Project',        type: 'text',       key: 'project' },
  due_date:       { label: 'Due Date',       type: 'date',       key: 'due_date' },
  scheduled_date: { label: 'Scheduled Date', type: 'date',       key: 'scheduled_date' },
  happens_date:   { label: 'Happens Date',   type: 'date',       key: 'happens_date' },
  created_at:     { label: 'Created Date',   type: 'date',       key: 'created_at' },
  title:          { label: 'Title',          type: 'text',       key: 'title' },
};

export const OPERATORS = {
  is:            'is',
  is_not:        'is not',
  contains:      'contains',
  not_contains:  'does not contain',
  is_empty:      'is empty',
  is_not_empty:  'is not empty',
  is_today:      'is today',
  is_before:     'is before',
  is_after:      'is after',
};

export const OPERATORS_BY_TYPE = {
  status:     ['is', 'is_not', 'is_empty', 'is_not_empty'],
  membership: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  text:       ['is', 'is_not', 'contains', 'is_empty', 'is_not_empty'],
  date:       ['is_today', 'is', 'is_before', 'is_after', 'is_empty', 'is_not_empty'],
};

export const SORTS = {
  priority_desc: 'Priority ↓',
  created_asc:   'Created Date ↑',
  due_asc:       'Due Date ↑',
  due_desc:      'Due Date ↓',
  has_due:       'Has Due Date',
};

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function _tokens(raw) {
  if (!raw) return [];
  return String(raw).trim().split(/\s+/).filter(Boolean);
}

// Normalise a tag/context token for comparison ("#Q1" → "q1", "@Desk" → "@desk").
function _norm(t) {
  return String(t || '').trim().replace(/^#/, '').toLowerCase();
}

// Local YYYY-MM-DD for "today".
function _todayYMD() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Date-only key from an ISO-ish string. Falls back to Date parsing.
function _dateYMD(v) {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${da}`;
}

function _fieldRaw(note, fieldId) {
  const meta = FIELDS[fieldId];
  if (!meta) return '';
  return note ? note[meta.key] : '';
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export function evaluateCondition(note, cond) {
  if (!cond) return true;
  if (cond.logic) return evaluateGroup(note, cond); // nested sub-group
  const meta = FIELDS[cond.field];
  if (!meta) return true;
  const raw = _fieldRaw(note, cond.field);
  const op = cond.op;
  const val = cond.value;

  if (meta.type === 'membership') {
    const toks = _tokens(raw).map(_norm);
    const target = _norm(val);
    switch (op) {
      case 'contains':     return toks.includes(target);
      case 'not_contains': return !toks.includes(target);
      case 'is_empty':     return toks.length === 0;
      case 'is_not_empty': return toks.length > 0;
      default:             return true;
    }
  }

  if (meta.type === 'date') {
    const ymd = _dateYMD(raw);
    switch (op) {
      case 'is_empty':     return !ymd;
      case 'is_not_empty': return !!ymd;
      case 'is_today':     return !!ymd && ymd === _todayYMD();
      case 'is':           return !!ymd && ymd === _dateYMD(val);
      case 'is_before':    return !!ymd && ymd < _dateYMD(val);
      case 'is_after':     return !!ymd && ymd > _dateYMD(val);
      default:             return true;
    }
  }

  // status / text
  const v = (raw == null ? '' : String(raw));
  switch (op) {
    case 'is':           return v === val;
    case 'is_not':       return v !== val;
    case 'contains':     return v.toLowerCase().includes(String(val || '').toLowerCase());
    case 'is_empty':     return !v.trim();
    case 'is_not_empty': return !!v.trim();
    default:             return true;
  }
}

export function evaluateGroup(note, group) {
  if (!group || !Array.isArray(group.conditions) || group.conditions.length === 0) return true;
  const results = group.conditions.map(c =>
    c && c.logic ? evaluateGroup(note, c) : evaluateCondition(note, c)
  );
  return (group.logic === 'OR') ? results.some(Boolean) : results.every(Boolean);
}

// ---------------------------------------------------------------------------
// Priority / matrix
// ---------------------------------------------------------------------------

export function matrixBucket(note) {
  const toks = _tokens(note && note.label).map(_norm);
  for (const q of ['q1', 'q2', 'q3', 'q4']) {
    if (toks.includes(q)) return q;
  }
  return null;
}

function _priorityRank(note) {
  const b = matrixBucket(note);
  return b ? Number(b[1]) : 99; // q1→1 … q4→4, none→99
}

// ---------------------------------------------------------------------------
// Sorting + applyView
// ---------------------------------------------------------------------------

function _sortTasks(tasks, sort) {
  const arr = tasks.slice();
  const field = (sort && sort.field) || 'priority_desc';
  const cmp = {
    priority_desc: (a, b) => _priorityRank(a) - _priorityRank(b),
    created_asc:   (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')),
    due_asc:       (a, b) => _dueKey(a).localeCompare(_dueKey(b)),
    due_desc:      (a, b) => _dueKey(b).localeCompare(_dueKey(a)),
    has_due:       (a, b) => {
      const ha = a.due_date ? 0 : 1, hb = b.due_date ? 0 : 1;
      return ha - hb || _dueKey(a).localeCompare(_dueKey(b));
    },
  }[field] || (() => 0);
  arr.sort(cmp);
  return arr;
}

// Empty due dates sort last under ascending order.
function _dueKey(n) {
  return n && n.due_date ? _dateYMD(n.due_date) : '9999-99-99';
}

/**
 * Filter + sort a task array against a view. Returns a new array.
 */
export function applyView(tasks, view) {
  if (!view) return tasks.slice();
  const filtered = (tasks || []).filter(t => evaluateGroup(t, view.group));
  return _sortTasks(filtered, view.sort);
}

// Count helper for view chips.
export function viewCount(tasks, view) {
  return (tasks || []).filter(t => evaluateGroup(t, view.group)).length;
}

// ---------------------------------------------------------------------------
// Default seed views (the user's 8 TaskForge lists)
// ---------------------------------------------------------------------------

const c = (field, op, value) => ({ field, op, value: value == null ? '' : value });
const and = (...conds) => ({ logic: 'AND', conditions: conds });
const or  = (...conds) => ({ logic: 'OR', conditions: conds });

// Quick-filter chip helpers.
const qfTag = (tag) => ({ id: 'tag:' + tag, label: tag, cond: c('tags', 'contains', tag) });
const qfCtx = (ctx) => ({ id: 'ctx:' + ctx, label: ctx, cond: c('contexts', 'contains', ctx) });

export function defaultGtdViews() {
  return [
    {
      id: 'inbox', name: 'Inbox', builtin: true, layout: 'list',
      group: and(c('status', 'is', 'todo'), c('contexts', 'is_empty')),
      sort: { field: 'created_asc' },
      quickFilters: [qfTag('#q1')],
    },
    {
      id: 'today', name: 'Today', builtin: true, layout: 'list',
      group: and(
        or(c('due_date', 'is_today'), c('scheduled_date', 'is_today'), c('happens_date', 'is_today')),
        c('status', 'is_not', 'done'),
        c('status', 'is_not', 'someday'),
      ),
      sort: { field: 'priority_desc' },
      quickFilters: [qfTag('#q1'), qfTag('#q2'), qfCtx('@Desk'), qfCtx('@Phone'), qfCtx('@Errands'), qfTag('#deep'), qfTag('#shallow')],
    },
    {
      id: 'next', name: 'Next Actions', builtin: true, layout: 'list',
      group: and(
        c('status', 'is', 'todo'),
        c('contexts', 'is_not_empty'),
        c('due_date', 'is_empty'),
        c('scheduled_date', 'is_empty'),
      ),
      sort: { field: 'priority_desc' },
      quickFilters: [qfCtx('@Desk'), qfCtx('@Home'), qfCtx('@Phone'), qfCtx('@Errands'), qfCtx('@Anywhere'), qfTag('#deep'), qfTag('#shallow'), qfTag('#q2'), qfTag('#5min'), qfTag('#15min'), qfTag('#30min')],
    },
    {
      id: 'waiting', name: 'Waiting For', builtin: true, layout: 'list',
      group: and(c('status', 'is', 'blocked')),
      sort: { field: 'created_asc' },
      quickFilters: [qfTag('#futurama'), qfTag('#pixfra'), qfTag('#pulsar')],
    },
    {
      id: 'projects', name: 'Projects', builtin: true, layout: 'list',
      group: and(
        c('project', 'is_not_empty'),
        c('status', 'is_not', 'done'),
        c('status', 'is_not', 'someday'),
      ),
      sort: { field: 'due_asc' },
      quickFilters: [qfTag('#futurama'), qfTag('#pixfra'), qfTag('#pulsar'), qfTag('#content'), qfTag('#side-biz'), qfTag('#q1')],
    },
    {
      id: 'someday', name: 'Someday / Maybe', builtin: true, layout: 'list',
      group: and(c('status', 'is', 'someday')),
      sort: { field: 'created_asc' },
      quickFilters: [qfTag('#content'), qfTag('#futurama'), qfTag('#personal'), qfTag('#side-biz')],
    },
    {
      id: 'home', name: 'Home', builtin: true, layout: 'list',
      group: and(
        c('contexts', 'contains', '@Home'),
        c('status', 'is_not', 'done'),
        c('status', 'is_not', 'someday'),
      ),
      sort: { field: 'priority_desc' },
      quickFilters: [qfTag('#5min'), qfTag('#30min'), qfTag('#personal')],
    },
    {
      id: 'desk', name: '@Desk board', builtin: true, layout: 'kanban',
      group: and(
        c('contexts', 'contains', '@Desk'),
        c('status', 'is_not', 'done'),
        c('status', 'is_not', 'someday'),
      ),
      sort: { field: 'priority_desc' },
      quickFilters: [qfTag('#futurama'), qfTag('#pixfra'), qfTag('#pulsar'), qfTag('#content'), qfTag('#deep'), qfTag('#shallow'), qfTag('#q1'), qfTag('#q2')],
    },
  ];
}

// Build a fresh empty custom view.
export function blankView() {
  return {
    id: 'view-' + Math.random().toString(36).slice(2, 10),
    name: 'New View',
    builtin: false,
    layout: 'list',
    group: { logic: 'AND', conditions: [c('status', 'is', 'todo')] },
    sort: { field: 'priority_desc' },
    quickFilters: [],
  };
}
