---
name: organizing-agent-docs
description: Use when recording durable knowledge or feedback for future sessions, editing AGENTS.md / REVIEW.md / a skill / a verified-facts or incidents ledger, or when AGENTS.md is growing long.
---

# ガイダンスの置き場所

将来のセッションに効かせたい知識・フィードバックは、セッション固有の memory でなく repo に置く。どの層に置くかはトリガーの広さで決める。

## 層の選択

| 知識の性質 | 置き場所 |
|---|---|
| 毎セッション効く規律 (ワークフロー・設計・検証の原則) | AGENTS.md — 常時ロードなので最小に保つ |
| 狭く検出可能なトリガーを持つ実装者向け指針 (特定のファイル型・タスク型でだけ要る) | skill (`skills/<name>/SKILL.md`) — on-demand ロード |
| 外部依存の確定仕様 | verified-facts ledger (`docs/verified-facts/<topic>.md`) — 必要時に読む |
| 過去の事故 (実害・レビューを貫通した欠陥) | incidents ledger (`docs/incidents.md`) |

迷う軸は「毎回読む価値があるか」。無いなら AGENTS.md から出す。

## 原則

- **単調増加するリストを AGENTS.md に置かない**: ツール列挙・事故ログは肥大を生み、「列挙外は対象外」と誤読させる。抽象化したクラス規律を AGENTS.md に、個々の実例は ledger に。
- **正本は agent-files**: 汎用規律は agent-files で直し各 repo へ伝播する。repo 固有の事実はその repo の ledger に置く。
- **足すときは融合する**: 新しい bullet を append せず、最も近い既存文に溶かして全体を短くする。減らす・統合する方向を選ぶ。
- **必要条件は必要条件と分かる形で書く**: 「X してから done と言う」は iff に読める。「done の必要条件」等にする。
