/**
 * AI-NI_ChatBot 대시보드 데이터 수집기
 *
 * GitHub Actions 에서 주기적으로 실행되어 공개 API 를 조회하고,
 * 결과를 data/nursing-informatics.json 으로 저장합니다.
 * 대시보드는 이 정적 JSON 만 읽으므로 브라우저 CORS 문제가 없습니다.
 *
 * 원칙
 *  - 인증키가 필요 없는 공식 API 만 사용합니다.
 *  - 분석 수치는 모두 결정적(deterministic) 산술로 계산합니다. 모델 추론을 쓰지 않습니다.
 *  - 조회에 실패하면 직전 실행 값을 유지하고 warnings 에 기록합니다.
 *
 * 실행: node scripts/collect.mjs [출력경로]
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/* ── 설정 ─────────────────────────────────────────────────────── */
const OUT_PATH = process.argv[2] || 'data/nursing-informatics.json';
const TOOL = 'AI-NI-ChatBot';
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const CTGOV = 'https://clinicaltrials.gov/api/v2/studies';

const REQUEST_DELAY_MS = 400;   // NCBI 권고: 키 없이 초당 3회 이하
const MAX_RETRIES = 3;
const TIMEOUT_MS = 25000;

const NURSE = 'nurs*[tiab]';
const TREND_START_YEAR = 2015;

/** 주제별 연구량 비교 (교과목 영역과 연결) */
const TOPICS = [
  { name: '전자건강기록 (EHR·EMR)', area: '03',
    query: `("electronic health record*"[tiab] OR "electronic medical record*"[tiab]) AND ${NURSE}` },
  { name: '임상의사결정지원 (CDSS)', area: '03',
    query: `"clinical decision support"[tiab] AND ${NURSE}` },
  { name: '표준 간호용어체계', area: '02',
    query: `("SNOMED"[tiab] OR "ICNP"[tiab] OR "LOINC"[tiab] OR "standardized nursing terminolog*"[tiab])` },
  { name: '상호운용성 (FHIR·HIE)', area: '02',
    query: `("FHIR"[tiab] OR "health information exchange"[tiab] OR "interoperability"[tiab]) AND (health[tiab] OR ${NURSE})` },
  { name: '간호 인공지능', area: '05',
    query: `("machine learning"[tiab] OR "artificial intelligence"[tiab] OR "deep learning"[tiab]) AND ${NURSE}` },
  { name: '생성형 AI·LLM', area: '06',
    query: `("large language model*"[tiab] OR "ChatGPT"[tiab] OR "generative artificial intelligence"[tiab]) AND ${NURSE}` },
  { name: '원격간호 (telehealth)', area: '07',
    query: `("telehealth"[tiab] OR "telenursing"[tiab] OR "telemedicine"[tiab]) AND ${NURSE}` },
  { name: '환자안전·간호민감지표', area: '09',
    query: `("patient safety"[tiab] OR "nurse-sensitive"[tiab]) AND (informatics[tiab] OR "electronic health record*"[tiab])` }
];

const TREND_QUERY = `("nursing informatics"[tiab] OR ("health informatics"[tiab] AND ${NURSE}))`;
const LLM_QUERY = `("large language model*"[tiab] OR "ChatGPT"[tiab] OR "generative artificial intelligence"[tiab]) AND ${NURSE}`;
const LLM_START_YEAR = 2021;

/** 디지털 헬스 임상시험 (ClinicalTrials.gov) */
const TRIALS = [
  { name: '원격간호·telehealth', area: '07', term: 'telehealth AND nursing' },
  { name: '원격환자모니터링 (RPM)', area: '07', term: 'remote patient monitoring' },
  { name: '디지털치료기기 (DTx)', area: '07', term: 'digital therapeutic' },
  { name: '임상의사결정지원', area: '03', term: 'clinical decision support system' },
  { name: '웨어러블 기반 중재', area: '07', term: 'wearable device intervention' }
];

const SOURCES = [
  { name: 'PubMed E-utilities', org: 'U.S. National Library of Medicine (NCBI)',
    url: 'https://www.ncbi.nlm.nih.gov/books/NBK25501/' },
  { name: 'ClinicalTrials.gov API v2', org: 'U.S. National Library of Medicine',
    url: 'https://clinicaltrials.gov/data-api/api' }
];

/* ── 유틸 ─────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const warnings = [];

function warn(message){
  warnings.push(message);
  console.warn('  [warn] ' + message);
}

async function fetchJson(url, label){
  for(let attempt = 1; attempt <= MAX_RETRIES; attempt++){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try{
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'accept': 'application/json', 'user-agent': TOOL + ' (educational dashboard)' }
      });
      clearTimeout(timer);
      if(!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    }catch(error){
      clearTimeout(timer);
      if(attempt === MAX_RETRIES){
        warn(`${label} 조회 실패 (${attempt}회 시도): ${error.message}`);
        return null;
      }
      await sleep(1200 * attempt);
    }
  }
  return null;
}

/** PubMed 검색 결과 건수. 실패 시 null */
async function pubmedCount(term, label){
  const url = `${EUTILS}?db=pubmed&retmode=json&rettype=count&tool=${TOOL}&term=${encodeURIComponent(term)}`;
  const json = await fetchJson(url, label);
  await sleep(REQUEST_DELAY_MS);
  if(!json || !json.esearchresult || json.esearchresult.count === undefined) return null;
  const n = Number(json.esearchresult.count);
  return Number.isFinite(n) ? n : null;
}

/** ClinicalTrials.gov 등록 건수. 실패 시 null */
async function trialsCount(term, label){
  const url = `${CTGOV}?query.term=${encodeURIComponent(term)}&countTotal=true&pageSize=1&fields=NCTId`;
  const json = await fetchJson(url, label);
  await sleep(REQUEST_DELAY_MS);
  if(!json || typeof json.totalCount !== 'number') return null;
  return json.totalCount;
}

/* ── 분석 (결정적 산술) ────────────────────────────────────────── */
const pct = (from, to) => (from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null);

/** 연평균 성장률(%) */
function cagr(from, to, years){
  if(!(from > 0) || !(to > 0) || !(years > 0)) return null;
  return Math.round((Math.pow(to / from, 1 / years) - 1) * 1000) / 10;
}

/** 최근 3개 완결연도의 방향 */
function direction(series){
  const complete = series.filter(p => !p.partial).slice(-3);
  if(complete.length < 3) return '판단 보류';
  const [a, b, c] = complete.map(p => p.count);
  if(c > b && b > a) return '지속 증가';
  if(c < b && b < a) return '지속 감소';
  if(c > a) return '증가 우세';
  if(c < a) return '감소 우세';
  return '보합';
}

/* ── 수집 ─────────────────────────────────────────────────────── */
async function collectYearSeries(query, startYear, currentYear, label){
  const series = [];
  for(let year = startYear; year <= currentYear; year++){
    const count = await pubmedCount(`${query} AND ${year}[dp]`, `${label} ${year}`);
    if(count === null) continue;
    series.push({ year, count, partial: year === currentYear });
  }
  return series;
}

async function collectTopics(latestYear, priorYear){
  const rows = [];
  for(const topic of TOPICS){
    const latest = await pubmedCount(`${topic.query} AND ${latestYear}[dp]`, `${topic.name} ${latestYear}`);
    const prior  = await pubmedCount(`${topic.query} AND ${priorYear}[dp]`,  `${topic.name} ${priorYear}`);
    if(latest === null && prior === null) continue;
    rows.push({
      name: topic.name,
      area: topic.area,
      query: topic.query,
      latest: latest ?? 0,
      prior: prior ?? 0,
      changePct: pct(prior ?? 0, latest ?? 0),
      cagrPct: cagr(prior ?? 0, latest ?? 0, latestYear - priorYear)
    });
  }
  return rows.sort((a, b) => b.latest - a.latest);
}

async function collectTrials(){
  const rows = [];
  for(const trial of TRIALS){
    const total = await trialsCount(trial.term, `임상시험 ${trial.name}`);
    if(total === null) continue;
    rows.push({ name: trial.name, area: trial.area, term: trial.term, total });
  }
  return rows.sort((a, b) => b.total - a.total);
}

/** 이번 실행에서 실패한 항목은 직전 결과로 메웁니다. */
async function loadPrevious(){
  try{
    return JSON.parse(await readFile(OUT_PATH, 'utf8'));
  }catch(e){
    return null;
  }
}

async function main(){
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const latestComplete = currentYear - 1;
  const priorYear = latestComplete - 5;

  console.log(`[collect] 기준 ${now.toISOString()} · 완결연도 ${latestComplete} · 비교연도 ${priorYear}`);

  const previous = await loadPrevious();

  console.log('[1/4] 간호정보학 연간 발행 추이');
  let trendSeries = await collectYearSeries(TREND_QUERY, TREND_START_YEAR, currentYear, '추이');

  console.log('[2/4] 주제별 연구량');
  let topics = await collectTopics(latestComplete, priorYear);

  console.log('[3/4] 생성형 AI·LLM 간호 연구');
  let llmSeries = await collectYearSeries(LLM_QUERY, LLM_START_YEAR, currentYear, 'LLM');

  console.log('[4/4] 디지털 헬스 임상시험');
  let trials = await collectTrials();

  // 실패 항목은 직전 값 유지
  if(previous){
    if(trendSeries.length === 0 && previous.trend?.series){ trendSeries = previous.trend.series; warn('추이 데이터를 직전 값으로 유지했습니다.'); }
    if(topics.length === 0 && previous.topics){ topics = previous.topics; warn('주제별 데이터를 직전 값으로 유지했습니다.'); }
    if(llmSeries.length === 0 && previous.llm?.series){ llmSeries = previous.llm.series; warn('LLM 데이터를 직전 값으로 유지했습니다.'); }
    if(trials.length === 0 && previous.trials){ trials = previous.trials; warn('임상시험 데이터를 직전 값으로 유지했습니다.'); }
  }

  const complete = trendSeries.filter(p => !p.partial);
  const latestPoint = complete[complete.length - 1] || null;
  const basePoint = complete.find(p => p.year === priorYear) || complete[0] || null;

  const fastest = topics.reduce((best, t) =>
    (t.changePct !== null && (!best || t.changePct > best.changePct)) ? t : best, null);

  const data = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    currentYear,
    latestCompleteYear: latestComplete,
    comparisonYear: priorYear,
    sources: SOURCES,
    notes: [
      'PubMed 건수는 검색 시점의 색인 상태에 따라 달라질 수 있습니다. 색인 지연으로 최근 연도는 이후 증가할 수 있습니다.',
      '진행 중인 연도(' + currentYear + ')는 부분 집계이므로 추세 계산에서 제외했습니다.',
      '검색식은 제목·초록(tiab) 기준이며, 주제 정의에 따라 건수가 달라집니다. 절대 수치보다 상대적 추세로 해석하십시오.'
    ],
    kpi: {
      latestYear: latestPoint ? latestPoint.year : null,
      latestCount: latestPoint ? latestPoint.count : null,
      baseYear: basePoint ? basePoint.year : null,
      baseCount: basePoint ? basePoint.count : null,
      changePct: (latestPoint && basePoint) ? pct(basePoint.count, latestPoint.count) : null,
      cagrPct: (latestPoint && basePoint) ? cagr(basePoint.count, latestPoint.count, latestPoint.year - basePoint.year) : null,
      direction: direction(trendSeries),
      topTopic: topics[0] ? topics[0].name : null,
      topTopicCount: topics[0] ? topics[0].latest : null,
      fastestTopic: fastest ? fastest.name : null,
      fastestTopicChange: fastest ? fastest.changePct : null,
      trialsTotal: trials.reduce((sum, t) => sum + t.total, 0)
    },
    trend: { label: '간호정보학 연간 발행 건수', query: TREND_QUERY, series: trendSeries },
    topics: { latestYear: latestComplete, priorYear, rows: topics },
    llm: { label: '생성형 AI·LLM 간호 연구', query: LLM_QUERY, series: llmSeries },
    trials: { label: '디지털 헬스 임상시험 등록 건수', rows: trials },
    warnings
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');

  console.log(`[collect] 완료 → ${OUT_PATH}`);
  console.log(`  추이 ${trendSeries.length}개 연도 · 주제 ${topics.length}개 · LLM ${llmSeries.length}개 연도 · 임상시험 ${trials.length}개`);
  if(warnings.length) console.log(`  경고 ${warnings.length}건`);
}

main().catch(error => {
  console.error('[collect] 치명적 오류:', error);
  process.exit(1);
});
