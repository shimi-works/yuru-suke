// planner / store / advisor-validate の検証。index.html から純関数ブロックを抽出して Node で実行する。
// 実行: node tests/planner.test.mjs
// 設計上の期待値は dev-os/projects/tatenaoshi/design.md の「plannerの仕様」に基づく。
// 日付の前提: 2026-07-13 は月曜日。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf-8");

function extract(startMark, endMark) {
  const s = html.indexOf(startMark);
  const e = html.indexOf(endMark);
  if (s === -1 || e === -1) throw new Error(`marker not found: ${startMark}`);
  return html.slice(s + startMark.length, e);
}

const src =
  extract("// ==PLANNER-START==", "// ==PLANNER-END==") +
  extract("// ==STORE-START==", "// ==STORE-END==") +
  extract("// ==ADVISOR-VALIDATE-START==", "// ==ADVISOR-VALIDATE-END==");
const { planner, store, advisorValidate } = new Function(
  src + "\nreturn { planner, store, advisorValidate };"
)();

let pass = 0, fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; }
  else { fail++; console.error(`  NG ${label}${detail ? ": " + detail : ""}`); }
}

// ---------- fixtures ----------

const CAP120 = { weekly: { mon: 120, tue: 120, wed: 120, thu: 120, fri: 120, sat: 120, sun: 120 }, overrides: {} };

function mkState({ tasks = [], milestones = [], capacity = CAP120, semesterEnd = "2026-08-07" } = {}) {
  return {
    version: 1,
    semester: { name: "2026前期", start: "2026-04-08", end: semesterEnd },
    subjects: [{ id: "s1", name: "科目A", color: "#7aa2f7" }],
    milestones,
    tasks,
    capacity: JSON.parse(JSON.stringify(capacity)),
    settings: { dayBoundaryHour: 3, geminiKey: null },
  };
}
function task(id, estMin, milestoneId = null, done = false) {
  return { id, subjectId: "s1", milestoneId, title: id, estMin, done, doneDate: null };
}
function ms(id, date, kind = "exam") {
  return { id, subjectId: "s1", title: id, date, kind };
}

// plan結果のヘルパ
function assignedMinOf(plan, taskId) {
  let total = 0;
  for (const chunks of Object.values(plan.assignments)) {
    for (const c of chunks) if (c.taskId === taskId) total += c.min;
  }
  return total;
}
function daySum(plan, date) {
  return (plan.assignments[date] || []).reduce((a, c) => a + c.min, 0);
}
function lastDayOf(plan, taskId) {
  let last = null;
  for (const [date, chunks] of Object.entries(plan.assignments)) {
    if (chunks.some((c) => c.taskId === taskId) && (!last || date > last)) last = date;
  }
  return last;
}

const TODAY = "2026-07-13"; // 月曜

// ---------- 1. 基本: 余裕ありなら締切前に全部収まり警告なし ----------
{
  console.log("case: 1-basic");
  const st = mkState({
    milestones: [ms("m1", "2026-07-18")],
    tasks: [task("t1", 60, "m1"), task("t2", 60, "m1"), task("t3", 60, "m1")],
  });
  const p = planner.plan(st, TODAY);
  check("警告なし", p.warnings.length === 0, JSON.stringify(p.warnings));
  for (const t of ["t1", "t2", "t3"]) {
    check(`${t} 全量割当`, assignedMinOf(p, t) === 60);
    check(`${t} 締切内`, lastDayOf(p, t) <= "2026-07-18", `last=${lastDayOf(p, t)}`);
  }
  for (const d of Object.keys(p.assignments)) {
    check(`容量以下 ${d}`, daySum(p, d) <= 120, `sum=${daySum(p, d)}`);
    check(`過去日に割当なし ${d}`, d >= TODAY);
  }
  // EDF貪欲: 今日から詰める
  check("今日に120分割当", daySum(p, TODAY) === 120, `sum=${daySum(p, TODAY)}`);
}

// ---------- 2. 締切密集: 試験3連続でも締切順に間に合う ----------
{
  console.log("case: 2-dense-deadlines");
  const st = mkState({
    milestones: [ms("mA", "2026-07-15"), ms("mB", "2026-07-16"), ms("mC", "2026-07-17")],
    tasks: [task("a1", 100, "mA"), task("a2", 100, "mA"), task("b1", 100, "mB"), task("c1", 100, "mC")],
  });
  const p = planner.plan(st, TODAY);
  check("警告なし", p.warnings.length === 0, JSON.stringify(p.warnings));
  check("a1 締切内", lastDayOf(p, "a1") <= "2026-07-15");
  check("a2 締切内", lastDayOf(p, "a2") <= "2026-07-15");
  check("b1 締切内", lastDayOf(p, "b1") <= "2026-07-16");
  check("c1 締切内", lastDayOf(p, "c1") <= "2026-07-17");
  for (const t of ["a1", "a2", "b1", "c1"]) check(`${t} 全量割当`, assignedMinOf(p, t) === 100);
  for (const d of Object.keys(p.assignments)) check(`容量以下 ${d}`, daySum(p, d) <= 120);
}

// ---------- 3. 破綻: 間に合わない締切は正直に警告し、割当自体は続ける ----------
{
  console.log("case: 3-infeasible");
  const st = mkState({
    milestones: [ms("m1", "2026-07-14")],
    tasks: [task("t1", 300, "m1"), task("t2", 200, "m1")],
  });
  const p = planner.plan(st, TODAY);
  const w = p.warnings.find((w) => w.type === "infeasible" && w.milestoneId === "m1");
  check("infeasible警告あり", !!w, JSON.stringify(p.warnings));
  // 必要500 − 可処分(7/13〜7/14: 240) = 260
  check("shortfallMin=260", w && w.shortfallMin === 260, w && `got ${w.shortfallMin}`);
  check("減量候補を提示", w && Array.isArray(w.reduceCandidates) && w.reduceCandidates.length > 0);
  check("割当は継続（全500分）", assignedMinOf(p, "t1") + assignedMinOf(p, "t2") === 500);
}

// ---------- 4. 繰越: 過去締切は警告、未完了は今日以降に自然に再割当 ----------
{
  console.log("case: 4-carryover");
  const st = mkState({
    milestones: [ms("m1", "2026-07-10")], // 既に過ぎた締切
    tasks: [task("t1", 60, "m1")],
  });
  const p = planner.plan(st, TODAY);
  check("締切超過警告あり", p.warnings.some((w) => w.type === "overdue" && w.milestoneId === "m1"), JSON.stringify(p.warnings));
  check("今日に再割当", (p.assignments[TODAY] || []).some((c) => c.taskId === "t1"));
  for (const d of Object.keys(p.assignments)) check(`過去日に割当なし ${d}`, d >= TODAY);
}

// ---------- 5. 分割: 1日の容量を超えるタスクは複数日に跨ぐ ----------
{
  console.log("case: 5-split");
  const st = mkState({
    milestones: [ms("m1", "2026-07-20")],
    tasks: [task("t1", 300, "m1")],
  });
  const p = planner.plan(st, TODAY);
  check("合計300分", assignedMinOf(p, "t1") === 300);
  check("3日に分割", Object.keys(p.assignments).length === 3, `days=${Object.keys(p.assignments).length}`);
  for (const d of Object.keys(p.assignments)) check(`容量以下 ${d}`, daySum(p, d) <= 120);
}

// ---------- 5b. 部分進捗: doneLog の分だけ残量が減る ----------
{
  console.log("case: 5b-partial-progress");
  const t = task("t1", 300, "m1");
  t.doneLog = { "2026-07-12": 120 }; // 昨日120分ぶん消化済み
  const st = mkState({ milestones: [ms("m1", "2026-07-20")], tasks: [t] });
  const p = planner.plan(st, TODAY);
  check("残り180分だけ割当", assignedMinOf(p, "t1") === 180, `got ${assignedMinOf(p, "t1")}`);
  check("remainingMin=180", planner.remainingMin(t) === 180, `got ${planner.remainingMin(t)}`);
  const doneTask = { ...task("t2", 100, "m1", true), doneLog: { "2026-07-10": 30 } };
  check("done=trueなら残り0", planner.remainingMin(doneTask) === 0);
}

// ---------- 5c. 今日の実績分は今日の容量から差し引く（二重計上防止） ----------
{
  console.log("case: 5c-today-capacity-minus-done");
  const t1 = task("t1", 60, "m1", true); t1.doneLog = { [TODAY]: 60 }; t1.doneDate = TODAY;
  const t2 = task("t2", 100, "m1");
  const st = mkState({ milestones: [ms("m1", "2026-07-20")], tasks: [t1, t2] });
  const p = planner.plan(st, TODAY);
  // 可処分120のうち60は実績済み → 今日はt2を60分だけ、残り40分は明日
  check("今日は60分まで", daySum(p, TODAY) === 60, `sum=${daySum(p, TODAY)}`);
  check("残り40分は明日", daySum(p, "2026-07-14") === 40, `sum=${daySum(p, "2026-07-14")}`);
}

// ---------- 6. 「今日は無理」: 今日の上書き0で全部明日以降へ ----------
{
  console.log("case: 6-not-today");
  const cap = JSON.parse(JSON.stringify(CAP120));
  cap.overrides[TODAY] = 0;
  const st = mkState({
    milestones: [ms("m1", "2026-07-18")],
    tasks: [task("t1", 60, "m1"), task("t2", 60, "m1")],
    capacity: cap,
  });
  const p = planner.plan(st, TODAY);
  check("今日は割当なし", !(TODAY in p.assignments), JSON.stringify(p.assignments[TODAY]));
  check("明日から割当", daySum(p, "2026-07-14") > 0);
  check("全量は維持", assignedMinOf(p, "t1") + assignedMinOf(p, "t2") === 120);
}

// ---------- 7. エッジ: 空・全完了・容量ゼロ ----------
{
  console.log("case: 7-edges");
  const p1 = planner.plan(mkState(), TODAY);
  check("空: 割当なし", Object.keys(p1.assignments).length === 0);
  check("空: 警告なし", p1.warnings.length === 0);

  const st2 = mkState({ milestones: [ms("m1", "2026-07-18")], tasks: [task("t1", 60, "m1", true)] });
  const p2 = planner.plan(st2, TODAY);
  check("全完了: 割当なし", Object.keys(p2.assignments).length === 0);
  check("全完了: 警告なし", p2.warnings.length === 0);

  const capZero = { weekly: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 }, overrides: {} };
  const st3 = mkState({ milestones: [ms("m1", "2026-07-18")], tasks: [task("t1", 60, "m1")], capacity: capZero });
  const p3 = planner.plan(st3, TODAY); // 無限ループしないこと自体も検証対象
  check("容量ゼロ: 割当なし", Object.keys(p3.assignments).length === 0);
  check("容量ゼロ: overflow警告", p3.warnings.some((w) => w.type === "overflow"), JSON.stringify(p3.warnings));
}

// ---------- 8. 細切れ回避: 残り容量がMIN_CHUNK未満なら次の日へ ----------
{
  console.log("case: 8-min-chunk");
  const st = mkState({
    milestones: [ms("m1", "2026-07-20")],
    tasks: [task("t1", 115, "m1"), task("t2", 60, "m1")],
  });
  const p = planner.plan(st, TODAY);
  check("今日はt1のみ(115)", daySum(p, TODAY) === 115, `sum=${daySum(p, TODAY)}`);
  check("t2は翌日開始", (p.assignments["2026-07-14"] || []).some((c) => c.taskId === "t2"));
}

// ---------- 9. 締切なしタスクは学期末扱いで最後 ----------
{
  console.log("case: 9-no-milestone");
  const st = mkState({
    milestones: [ms("m1", "2026-07-15")],
    tasks: [task("free1", 60, null), task("t1", 100, "m1")],
    semesterEnd: "2026-08-07",
  });
  const p = planner.plan(st, TODAY);
  check("締切ありが先", (p.assignments[TODAY] || [])[0].taskId === "t1");
  check("free1も全量割当", assignedMinOf(p, "free1") === 60);
  check("free1は学期末まで", lastDayOf(p, "free1") <= "2026-08-07");
}

// ---------- 10. 日付ユーティリティ ----------
{
  console.log("case: 10-date-utils");
  check("addDays 月跨ぎ", planner.addDays("2026-07-31", 1) === "2026-08-01", planner.addDays("2026-07-31", 1));
  check("addDays 負数", planner.addDays("2026-08-01", -1) === "2026-07-31");
  check("dayOfWeek 月曜", planner.dayOfWeek("2026-07-13") === "mon", planner.dayOfWeek("2026-07-13"));
  check("dayOfWeek 日曜", planner.dayOfWeek("2026-07-12") === "sun");
  // 日付境界3時: 深夜2:30は前日扱い、3:00から当日
  check("境界前は前日", planner.effectiveToday(new Date(2026, 6, 13, 2, 30), 3) === "2026-07-12");
  check("境界後は当日", planner.effectiveToday(new Date(2026, 6, 13, 3, 0), 3) === "2026-07-13");
  check("境界0は暦日", planner.effectiveToday(new Date(2026, 6, 13, 0, 10), 0) === "2026-07-13");
}

// ---------- 11. store: migrate / normalize / import ----------
{
  console.log("case: 11-store");
  const d = store.migrate(null);
  check("null→既定状態", d.version === store.CURRENT_VERSION && Array.isArray(d.tasks) && Array.isArray(d.subjects));
  check("既定に容量テンプレ", d.capacity && d.capacity.weekly && typeof d.capacity.weekly.mon === "number");

  const st = mkState({ tasks: [task("t1", 60)] });
  const m = store.migrate(JSON.parse(JSON.stringify(st)));
  check("既存stateを保持", m.tasks.length === 1 && m.tasks[0].id === "t1");

  const partial = store.migrate({ version: 1, tasks: [task("t1", 60)] });
  check("欠損フィールドを補完", !!(partial.capacity && partial.capacity.weekly && partial.settings && partial.semester));

  let threw = false;
  try { store.importJSON("{not json"); } catch { threw = true; }
  check("壊れたJSONはthrow", threw);

  let threw2 = false;
  try { store.importJSON('"just a string"'); } catch { threw2 = true; }
  check("オブジェクトでないJSONはthrow", threw2);

  const round = store.importJSON(store.exportJSON(st));
  check("export→importで一致", JSON.stringify(round) === JSON.stringify(store.migrate(st)));
}

// ---------- 12. advisorValidate: AI応答の3段ガードの1段目 ----------
{
  console.log("case: 12-advisor-validate");
  const st = mkState({ milestones: [ms("m1", "2026-07-18")], tasks: [task("t1", 60, "m1")] });

  const ok = advisorValidate({
    advice: "無理のない計画です",
    capacityChanges: [{ date: "2026-07-14", minutes: 90 }],
    taskChanges: [{ taskId: "t1", newEstMin: 90 }],
  }, st, TODAY);
  check("正常応答はok", ok.ok, JSON.stringify(ok.errors));
  check("変更が正規化される", ok.changes.length === 2);

  const bad1 = advisorValidate({ advice: "x", capacityChanges: [{ date: "7/14", minutes: 90 }], taskChanges: [] }, st, TODAY);
  check("日付形式不正を拒否", !bad1.ok);

  const bad2 = advisorValidate({ advice: "x", capacityChanges: [], taskChanges: [{ taskId: "nope", newEstMin: 60 }] }, st, TODAY);
  check("未知taskIdを拒否", !bad2.ok);

  const bad3 = advisorValidate({ advice: "x", capacityChanges: [{ date: "2026-07-14", minutes: 99999 }], taskChanges: [] }, st, TODAY);
  check("分数の範囲外を拒否", !bad3.ok);

  const bad4 = advisorValidate({ advice: "x", capacityChanges: [], taskChanges: [{ taskId: "t1", done: true }] }, st, TODAY);
  check("完了状態の書換は無視される（事実の改変不可）", bad4.ok && bad4.changes.every((c) => !("done" in (c.patch || {}))));

  const bad5 = advisorValidate(null, st, TODAY);
  check("null応答を拒否", !bad5.ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
