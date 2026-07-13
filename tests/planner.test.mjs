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
  extract("// ==ADVISOR-VALIDATE-START==", "// ==ADVISOR-VALIDATE-END==") +
  extract("// ==UTIL-START==", "// ==UTIL-END==");
const { planner, store, advisorValidate, parseTaskLines, buildICS, milestoneProgress, reviewStats } = new Function(
  src + "\nreturn { planner, store, advisorValidate, parseTaskLines, buildICS, milestoneProgress, reviewStats };"
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

  // 信頼できない入力の無害化（インポート経由XSS・クラッシュの回帰テスト）
  const dirty = store.migrate({
    subjects: [{ id: "s1", name: "A", color: 'x"><img src=x onerror=alert(1)>' }],
    milestones: [{ id: "m1", subjectId: "s1", title: "T", date: "2026-08-01", kind: '"><script>x</script>' }],
    capacity: { weekly: { mon: "<img>" }, overrides: { "not-a-date": 60, "2026-07-20": "90" } },
    settings: { dayBoundaryHour: "bad", geminiModel: "evil/../model" },
  });
  check("不正colorは既定色に", /^#[0-9a-fA-F]{3,8}$/.test(dirty.subjects[0].color), dirty.subjects[0].color);
  check("不正kindは既定に", dirty.milestones[0].kind === "exam", dirty.milestones[0].kind);
  check("weeklyは数値化", typeof dirty.capacity.weekly.mon === "number");
  check("不正な日付キーのoverridesは捨てる", !("not-a-date" in dirty.capacity.overrides));
  check("overrides値は数値化", dirty.capacity.overrides["2026-07-20"] === 90);
  check("不正dayBoundaryHourは既定3に", dirty.settings.dayBoundaryHour === 3);
  check("不正geminiModelは既定に", store.GEMINI_MODELS.includes(dirty.settings.geminiModel), dirty.settings.geminiModel);
  // 汚染されたdayBoundaryHourでもplanが例外を投げない（正規化後なので当然通る）
  const p = planner.plan(dirty, planner.effectiveToday(new Date(2026, 6, 13, 12, 0), dirty.settings.dayBoundaryHour));
  check("正規化後のplanは例外なし", !!p && typeof p.assignments === "object");

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

  // 完了状態の書き換え指示は変更として一切生成されない（事実の改変不可）
  const bad4 = advisorValidate({ advice: "x", capacityChanges: [], taskChanges: [{ taskId: "t1", done: true }] }, st, TODAY);
  check("完了状態の書換は無視される", bad4.ok && bad4.changes.length === 0, JSON.stringify(bad4.changes));
  const mixed = advisorValidate({ advice: "x", capacityChanges: [], taskChanges: [{ taskId: "t1", newEstMin: 90, done: true, date: "2099-01-01" }] }, st, TODAY);
  check("許可フィールド以外は落ちる", mixed.ok && mixed.changes.length === 1 &&
    Object.keys(mixed.changes[0]).sort().join(",") === "newEstMin,taskId,type", JSON.stringify(mixed.changes));

  const bad5 = advisorValidate(null, st, TODAY);
  check("null応答を拒否", !bad5.ok);

  const bad6 = advisorValidate({ advice: "x", capacityChanges: [{ date: "2020-01-01", minutes: 60 }], taskChanges: [] }, st, TODAY);
  check("過去日への変更を拒否", !bad6.ok);
}

// ---------- 13. parseTaskLines: 一括追加の行パース ----------
{
  console.log("case: 13-parse-task-lines");
  const r = parseTaskLines("第3章 p45-60\n過去問 90\n\n  序論を書く 30分  \n第4章 p61-78 60", 120);
  check("空行を除いて4件", r.length === 4, JSON.stringify(r));
  check("末尾分なしは既定120", r[0].title === "第3章 p45-60" && r[0].estMin === 120, JSON.stringify(r[0]));
  check("末尾数字を分に", r[1].title === "過去問" && r[1].estMin === 90, JSON.stringify(r[1]));
  check("「分」付きも解釈", r[2].title === "序論を書く" && r[2].estMin === 30, JSON.stringify(r[2]));
  check("途中のp61-78は範囲のまま末尾60が分", r[3].title === "第4章 p61-78" && r[3].estMin === 60, JSON.stringify(r[3]));
  check("空文字は空配列", parseTaskLines("", 120).length === 0);
  check("全角空白区切りも解釈", parseTaskLines("演習　45", 120)[0].estMin === 45);
  check("5分未満は5に丸め", parseTaskLines("小問 1", 120)[0].estMin === 5);
  check("明示的な0も5に丸め（既定に化けない）", parseTaskLines("小問 0", 60)[0].estMin === 5, JSON.stringify(parseTaskLines("小問 0", 60)[0]));
  check("0分表記も5", parseTaskLines("小問 0分", 60)[0].estMin === 5);
  check("上限1440でクランプ", parseTaskLines("巨大 9999", 60)[0].estMin === 1440);
  check("単独\\rの改行も分割", parseTaskLines("A 30\rB 40", 60).length === 2);
}

// ---------- 14. buildICS: カレンダーエクスポート ----------
{
  console.log("case: 14-build-ics");
  const stamp = "20260713T000000Z";
  const st = mkState({
    milestones: [ms("m1", "2026-07-18", "report")],
    tasks: [task("t1", 120, "m1"), task("t2", 60, "m1", true)], // t2は完了済み
  });
  const ics = buildICS(st, { today: TODAY, horizonDays: 14, dtstamp: stamp, kindLabel: { report: "レポート" } });
  check("VCALENDARで囲む", ics.startsWith("BEGIN:VCALENDAR") && ics.trimEnd().endsWith("END:VCALENDAR"));
  check("CRLF改行", ics.includes("\r\n"));
  check("末尾もCRLFで終端", ics.endsWith("END:VCALENDAR\r\n"));
  // 締切SUMMARYは「📌 科目名 締切名（種類）」の順で結合される（titleを落とすと壊れる）
  check("締切SUMMARYが正しい形", ics.includes("SUMMARY:📌 科目A m1（レポート）"), ics);
  check("終日DTSTART形式", ics.includes("DTSTART;VALUE=DATE:20260718"));
  check("DTSTAMPは引数値", ics.includes("DTSTAMP:" + stamp));
  check("kindLabelを反映", ics.includes("（レポート）"));
  check("残タスクt1をDESCRIPTIONに", /DESCRIPTION:.*t1/.test(ics));
  check("完了t2は残りに出ない", !/DESCRIPTION:.*t2/.test(ics));
  check("割り当て予定イベントを含む", ics.includes("📖 t1"));
  // 特殊文字エスケープ
  const st2 = mkState({ milestones: [{ id: "m9", subjectId: "s1", title: "A; B, C\nD", date: "2026-07-20", kind: "exam" }], tasks: [] });
  const ics2 = buildICS(st2, { today: TODAY, horizonDays: 7, dtstamp: stamp, kindLabel: {} });
  check("セミコロン/カンマ/改行をエスケープ", ics2.includes("A\\; B\\, C\\nD"), ics2);
  // 過去の締切は出ない
  const st3 = mkState({ milestones: [ms("mp", "2026-07-01", "exam")], tasks: [task("tp", 60, "mp")] });
  const ics3 = buildICS(st3, { today: TODAY, horizonDays: 14, dtstamp: stamp, kindLabel: {} });
  check("過去締切イベントは出ない", !ics3.includes("ms-mp@"));
  // UIDが一意（重複行なし）
  const uids = (ics.match(/UID:[^\r\n]+/g) || []);
  check("UIDは重複しない", new Set(uids).size === uids.length, uids.join(","));

  // 長大DESCRIPTION（一括追加で残タスクが積み上がるケース）でも各物理行が75オクテット以内に折られる
  const many = mkState({
    milestones: [ms("mL", "2026-07-30", "report")],
    tasks: Array.from({ length: 20 }, (_, i) => task("bt" + i, 30, "mL")).map((t, i) => ({ ...t, title: "第" + (i + 1) + "章 演習問題を解いてノートにまとめる" })),
  });
  const icsL = buildICS(many, { today: TODAY, horizonDays: 21, dtstamp: stamp, kindLabel: { report: "レポート" } });
  const enc = new TextEncoder();
  const overLong = icsL.split("\r\n").filter((l) => enc.encode(l).length > 75);
  check("全物理行が75オクテット以内", overLong.length === 0, "over=" + overLong.length + " 最長=" + Math.max(0, ...icsL.split("\r\n").map((l) => enc.encode(l).length)));
  // 折り畳み後も論理的に復元できる（継続行= CRLF+空白 を畳み直すと元の論理行）
  const unfolded = icsL.replace(/\r\n /g, "");
  check("折り畳みを畳み直すと締切SUMMARYが復元", unfolded.includes("SUMMARY:📌 科目A mL（レポート）"), unfolded.slice(0, 200));
}

// ---------- 15. milestoneProgress: 締切ごとの進捗 ----------
{
  console.log("case: 15-milestone-progress");
  const t1 = task("t1", 60, "m1");
  const t2 = task("t2", 60, "m1", true); t2.doneLog = { "2026-07-12": 60 };
  const t3 = task("t3", 120, "m1"); t3.doneLog = { "2026-07-12": 30 }; // 部分進捗
  const st = mkState({ milestones: [ms("m1", "2026-07-25")], tasks: [t1, t2, t3] });
  const p = milestoneProgress(st, "m1");
  check("総見積もり=240", p.total === 240, "total=" + p.total);
  check("残り=150（t1 60 + t3 90）", p.remain === 150, "remain=" + p.remain);
  check("消化=90（t2 60 + t3 30）", p.done === 90, "done=" + p.done);
  check("pct=38（90/240四捨五入）", p.pct === 38, "pct=" + p.pct);
  check("タスク数=3", p.taskCount === 3);
  check("完了タスク数=1（t2のみ）", p.doneCount === 1, "doneCount=" + p.doneCount);

  const empty = milestoneProgress(mkState({ milestones: [ms("m2", "2026-07-25")], tasks: [] }), "m2");
  check("タスクなしはpct0・件数0", empty.pct === 0 && empty.taskCount === 0 && empty.total === 0);

  const allDone = milestoneProgress(mkState({ milestones: [ms("m3", "2026-07-25")], tasks: [task("d1", 60, "m3", true), task("d2", 30, "m3", true)] }), "m3");
  check("全完了はpct100・remain0", allDone.pct === 100 && allDone.remain === 0 && allDone.doneCount === 2);
}

// ---------- 16. reviewStats: タスクベースの振り返り（時間を使わない） ----------
{
  console.log("case: 16-review-stats");
  const dtask = (id, msId, done, doneDate) => ({ id, subjectId: "s1", milestoneId: msId, title: id, estMin: 60, done, doneDate: doneDate || null, doneLog: {} });
  const st = mkState({
    milestones: [ms("mA", "2026-07-10"), ms("mB", "2026-07-11"), ms("mFut", "2026-07-20")],
    tasks: [
      dtask("tA1", "mA", true, "2026-07-09"), // 締切07-10までに完了
      dtask("tA2", "mA", true, "2026-07-09"),
      dtask("tB1", "mB", false, null),        // 過去締切だが未完了 → 遅れ
      dtask("tF1", "mFut", true, "2026-07-12"),
      dtask("tF2", "mFut", false, null),
    ],
  });
  const R = reviewStats(st, TODAY); // TODAY = 2026-07-13

  check("全タスク5・完了3・pct60", R.total === 5 && R.done === 3 && R.pct === 60, JSON.stringify({ t: R.total, d: R.done, p: R.pct }));
  // 締切の結果
  const byId = Object.fromEntries(R.deadlines.map((m) => [m.id, m]));
  check("mA=間に合った", byId.mA.status === "ontime", byId.mA.status);
  check("mB=遅れ（未完了が残る過去締切）", byId.mB.status === "late", byId.mB.status);
  check("mFut=これから（未来）", byId.mFut.status === "upcoming", byId.mFut.status);
  check("mFutの完了率50", byId.mFut.pct === 50, "" + byId.mFut.pct);
  check("締切は日付昇順", R.deadlines[0].id === "mA" && R.deadlines[2].id === "mFut");
  // 期限後に完了した場合は遅れ扱い（誠実さ）
  const late = reviewStats(mkState({ milestones: [ms("mL", "2026-07-05")], tasks: [dtask("x", "mL", true, "2026-07-08")] }), TODAY);
  check("期限後完了は遅れ", late.deadlines[0].status === "late", late.deadlines[0].status);
  // 連続達成: 今日は未完、昨日(07-12)にtF1完了 → streak=1
  check("streak=1（昨日から）", R.streak === 1, "streak=" + R.streak);
  // 今日完了があれば今日を含む
  const withToday = reviewStats(mkState({ milestones: [ms("mT", "2026-07-20")], tasks: [dtask("y1", "mT", true, TODAY), dtask("y2", "mT", true, "2026-07-12")] }), TODAY);
  check("streak=2（今日+昨日）", withToday.streak === 2, "streak=" + withToday.streak);
  // 14日ぶんの件数配列（末尾が今日）
  check("days配列は14日ぶん", R.days.length === 14 && R.days[13].date === TODAY);
  check("07-09に2件・07-12に1件", R.days.find((d) => d.date === "2026-07-09").count === 2 && R.days.find((d) => d.date === "2026-07-12").count === 1);
  // 科目ごと
  check("科目A: 3/5 pct60", R.bySubject.length === 1 && R.bySubject[0].done === 3 && R.bySubject[0].pct === 60);
  // 空
  const empty = reviewStats(mkState(), TODAY);
  check("空はtotal0・streak0・締切0", empty.total === 0 && empty.streak === 0 && empty.deadlines.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
