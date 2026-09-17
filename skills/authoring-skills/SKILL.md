---
name: authoring-skills
description: Use when creating, editing, or reviewing a skill (a SKILL.md or the files it links to).
---

# スキルの書き方

スキルをどの層に置くか (AGENTS.md・skill・canon) は [organizing-agent-docs](../organizing-agent-docs/SKILL.md)。ここはスキルの中身の書き方。

## description

- いつ使うか (トリガー) だけを 1 行で書く。手順やスキルの中身を要約しない。要約があると本文を読まずに要約だけで動かれる。
- トリガーは、利用者がその場で観測できる語 (タスクの種類・ツール名・エラー文) で書く。

## 本文に置くもの

- スキル利用者が行動するのに要る指示だけを書く。
- 外部の性質の説明・実測の条件と経緯は canon (`facts/<topic>/`) に置き、本文からは `canon: facts/<topic>/<page>` で参照する。
- canon を読めない環境 (cc-web 等) でも使うスキルでは、行動に要る手順・注意は本文に残し、canon 参照は根拠として添えるだけにする。削るときは「この一文が無いと利用者が誤った行動をするか」で判定する。
- 善意の編集で壊れる箇所 (外すと壊れるフラグ・書き換えてはいけないコマンド) は「〜を外さない」と短く書き、理由は canon に置く。

## ファイルの分け方

- 分ける基準は長さでなく、その内容が毎回要るか。SKILL.md は読まれると全体がコンテキストに入り、リンク先は開いたときだけ入る。
- 普通は必要にならないもの (フォールバック・環境ごとの別手段・まれな分岐・長いスクリプト例) は別の md に出し、SKILL.md からは「どういうときに開くか」を添えてリンクする。例: pr-workflow の手段ファイル (gh / MCP ごと)、cc-web-sandbox-signals の create-then-sweep。
- 別ファイルは SKILL.md からの相対リンクで参照する。別ファイルからさらに別ファイルへ辿らせない (1 段まで)。

## 文体

[writing-comments](../writing-comments/SKILL.md) の「自然言語の書き方」に従う。
