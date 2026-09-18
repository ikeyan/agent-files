テストが setup で変えたものを、assert が失敗しても実行される場所で元に戻しているか。

検出手順: diff 内のテストが変えるもの (一時ファイル・一時ディレクトリ、環境変数・グローバル・cwd の書き換え、モックの差し替え、起動したサーバ・プロセス) を全て列挙し、各々を戻す行を引用する。戻す行が無いか、テスト本体の末尾にあって assert の失敗で飛ばされるなら、afterEach / finally / `using` に移す案を出す。フレームワークの API 名はリポ固有の検索対象に従う。
匂い: beforeEach にあって afterEach に対応が無い, テスト本体の末尾だけにある復元, `process.env.X =` の代入, `process.chdir`, restore の無い mock / spy
