#!/usr/bin/env node
// Scans public repos across configured GitHub accounts and updates AI-assisted
// commit stats between <!-- AI-STATS:START/END --> and <!-- AI-PROJECTS:START/END -->
// markers in README.md.
//
// Methodology
// -----------
// A commit is "AI-assisted" if its message contains a `Co-Authored-By:` trailer
// matching a known AI tool (Claude, GitHub Copilot, OpenCode). Each commit is
// attributed to at most one tool (first match wins). Only non-fork, non-archived
// repos are counted. Private repos are scanned only if GH_TOKEN has access.
//
// Provide a fine-grained PAT via the READ_REPOS_TOKEN secret to include private
// repos; otherwise the default GITHUB_TOKEN limits the scan to public repos.

import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('Missing GH_TOKEN / GITHUB_TOKEN');
  process.exit(1);
}

const ACCOUNTS = [
  { type: 'user', name: 'nasrulhazim' },
  { type: 'org',  name: 'cleaniquecoders' },
  { type: 'org',  name: 'nadi-pro' },
  { type: 'org',  name: 'developers-hub-my' },
];

const AI_PATTERNS = [
  { name: 'Claude',   rx: /co-authored-by:\s*claude\b/i },
  { name: 'Copilot',  rx: /co-authored-by:\s*(github[- ]?)?copilot\b/i },
  { name: 'OpenCode', rx: /co-authored-by:\s*opencode\b/i },
];

const CLAUDE_MODEL_RX = /claude[\s-]+(opus|sonnet|haiku)\s*([\d.]+)/gi;

async function gh(path, params = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nasrulhazim-readme-bot',
    },
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} — ${url.pathname}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function listRepos({ type, name }) {
  const base = type === 'org' ? `/orgs/${name}/repos` : `/users/${name}/repos`;
  const repos = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await gh(base, { per_page: 100, page, type: 'owner', sort: 'updated' });
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter(r => !r.fork && !r.archived && !r.disabled);
}

async function commitsFor(fullName) {
  const commits = [];
  for (let page = 1; page <= 50; page++) {
    let batch;
    try {
      batch = await gh(`/repos/${fullName}/commits`, { per_page: 100, page });
    } catch (e) {
      if (e.status === 409 || e.status === 404 || e.status === 403) return commits;
      throw e;
    }
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  return commits;
}

function classify(message) {
  for (const p of AI_PATTERNS) if (p.rx.test(message)) return p.name;
  return null;
}

function cap(s) { return s[0].toUpperCase() + s.slice(1); }

function replaceBetween(text, marker, body) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const rx = new RegExp(`${escapeRx(start)}[\\s\\S]*?${escapeRx(end)}`);
  if (!rx.test(text)) {
    console.warn(`marker ${marker} not found — skipping`);
    return text;
  }
  return text.replace(rx, `${start}\n${body}\n${end}`);
}

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function main() {
  const perTool = Object.fromEntries(AI_PATTERNS.map(p => [p.name, 0]));
  const projectTotals = {};
  const projectAi = {};
  const projectDesc = {};
  const modelsSeen = new Set();
  let totalCommits = 0;
  let aiCommits = 0;

  const repos = [];
  for (const acc of ACCOUNTS) {
    console.log(`listing ${acc.type}/${acc.name}`);
    try {
      repos.push(...(await listRepos(acc)));
    } catch (e) {
      console.warn(`  skipped ${acc.name}: ${e.message}`);
    }
  }
  console.log(`scanning ${repos.length} repos`);

  for (const repo of repos) {
    process.stdout.write(`  ${repo.full_name}... `);
    const commits = await commitsFor(repo.full_name);
    projectTotals[repo.full_name] = commits.length;
    projectDesc[repo.full_name] = repo.description || '';
    let ai = 0;
    for (const c of commits) {
      const msg = c.commit?.message || '';
      const tool = classify(msg);
      if (tool) {
        ai++;
        perTool[tool]++;
        for (const m of msg.matchAll(CLAUDE_MODEL_RX)) {
          modelsSeen.add(`${cap(m[1])} ${m[2]}`);
        }
      }
    }
    projectAi[repo.full_name] = ai;
    totalCommits += commits.length;
    aiCommits += ai;
    console.log(`${commits.length} commits, ${ai} AI`);
  }

  const projectsWithAi = Object.values(projectAi).filter(n => n > 0).length;
  const pct = totalCommits ? (aiCommits / totalCommits * 100).toFixed(1) : '0.0';
  const modelsList = [...modelsSeen].sort().join(', ') || 'n/a';

  const statsTable = [
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Projects | ${Object.keys(projectTotals).length} |`,
    `| Total Commits | ${totalCommits.toLocaleString()} |`,
    `| AI-Assisted Commits | ${aiCommits} (${pct}%) |`,
    `| Projects with AI | ${projectsWithAi} |`,
    `| Claude Models Used | ${modelsList} |`,
    '| AI Journey | ChatGPT (2024) → Copilot (mid-2025) → Claude (Nov 2025) |',
    '',
    `_Last updated: ${new Date().toISOString().slice(0, 10)} · public repos only_`,
  ].join('\n');

  const topProjects = Object.entries(projectAi)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);

  const projTable = topProjects.length
    ? [
        '| Project | Total | AI Commits | AI % | Description |',
        '|---------|------:|----------:|-----:|-------------|',
        ...topProjects.map(([fn, ai]) => {
          const total = projectTotals[fn];
          const p = total ? (ai / total * 100).toFixed(1) : '0.0';
          const desc = (projectDesc[fn] || '').replace(/\|/g, '\\|');
          return `| [${fn}](https://github.com/${fn}) | ${total} | ${ai} | ${p}% | ${desc} |`;
        }),
      ].join('\n')
    : '_No AI-assisted commits detected in public repos yet._';

  const readmePath = 'README.md';
  let readme = readFileSync(readmePath, 'utf8');
  readme = replaceBetween(readme, 'AI-STATS', statsTable);
  readme = replaceBetween(readme, 'AI-PROJECTS', projTable);
  writeFileSync(readmePath, readme);

  console.log('\nSummary:');
  console.log(`  total commits: ${totalCommits}`);
  console.log(`  AI commits: ${aiCommits} (${pct}%)`);
  for (const [tool, n] of Object.entries(perTool)) console.log(`    ${tool}: ${n}`);
  console.log(`  projects with AI: ${projectsWithAi}`);
  console.log(`  Claude models: ${modelsList}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
