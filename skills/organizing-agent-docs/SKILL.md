---
name: organizing-agent-docs
description: Use when recording durable knowledge or feedback for future sessions, editing AGENTS.md / REVIEW.md / a skill / the canon ledger (verified facts about external dependencies, incidents), or when AGENTS.md is growing long.
---

# ガイダンスの置き場所

将来のセッションに効かせたい知識・フィードバックは、セッション固有の memory でなく repo に置く。どの層に置くかはトリガーの広さで決める。

## 層の選択

| 知識の性質 | 置き場所 |
|---|---|
| 毎セッション効く規律 (ワークフロー・設計・検証の原則) | AGENTS.md — 常時ロードなので最小に保つ |
| 狭く検出可能なトリガーを持つ実装者向け指針 (特定のファイル型・タスク型でだけ要る) | skill (`skills/<name>/SKILL.md`) — on-demand ロード |
| 外部依存 (CLI・ライブラリ・カーネル・API) の確定仕様 | canon の `facts/<topic>/` — 必要時に読む |
| 過去の事故 (実害・レビューを貫通した欠陥) | canon の `incidents/` |

迷う軸は「毎回読む価値があるか」。無いなら AGENTS.md から出す。

canon が手元に無ければ clone する。Claude Code remote でも Claude 自身なら取得できる (add repo → `git clone` → repo root を register)。ただし**環境セットアップスクリプトからは取得できない**ので、canon の取得をそこに書かない。

移行期間中は各 repo に残る `docs/verified-facts/` と `docs/incidents.md` を **read-only** として扱う — 探すときは読むが、書くのは canon だけ。全 repo の移設が済んだらこの段落を消す。

## 原則

- **単調増加するリストを AGENTS.md に置かない**: ツール列挙・事故ログは肥大を生み、「列挙外は対象外」と誤読させる。抽象化したクラス規律を AGENTS.md に、個々の実例は canon に。
- **規律の正本は agent-files、事実の正本は canon** (`ikeyan/canon`): 汎用規律は agent-files で直し各 repo へ伝播する。外部依存の確定仕様と事故は repo を問わず canon に集める (同じ contract が repo ごとに分裂しないため)。canon に書くのは主語が外部依存側の事実だけ — repo 自身の構成・運用手順は README か対象コード近傍のコメントに置く (混ぜると外部仕様と自分の実装が同じ確度の「確定事実」に見え、他 repo には無関係な手順が混ざる)。実測の再現に要る repo の文脈は evidence なので残す。
- **足すときは融合する**: 新しい bullet を append せず、最も近い既存文に溶かして全体を短くする。減らす・統合する方向を選ぶ。
- **必要条件は必要条件と分かる形で書く**: 「X してから done と言う」は iff に読める。「done の必要条件」等にする。
