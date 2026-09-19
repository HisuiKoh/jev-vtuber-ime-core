# jev-vtuber-ime-core

読みを入れると VTuber の表記を返します。辞書は持っていません。毎回 Web 検索して、その結果を根拠に [Jev (TypeSafe AI)](https://typesafe.ai/) が判定します。

Jev 公式とは一切関係はありません。

```
$ jev-vtuber-ime きねつきのあ
きねつきのあ → 杵月のあ

$ jev-vtuber-ime うさだぺこら
うさだぺこら → 兎田ぺこら

$ jev-vtuber-ime はしもとかんな
はしもとかんな → 見つかりませんでした
```

- **VTuber の名前データを一切持ちません。** 検索結果に書いてあることだけを根拠にします。
- **API キーは自分のものを使います。** 作者にはお金もデータも入りません。
- **VTuber 以外は返しません。** 実在の人物・声優・一般名詞は「見つかりませんでした」になります。
- IME 辞書ではありません。変換候補は出ません。

## 仕組み

1. 読みで Web 検索します（`SEARCH_ORDER` の順に試し、枯れたら次へ。対応: Monid/TinyFish ($0)、Brave、Google Programmable Search）。
2. 検索結果のタイトル・スニペットから名前らしい文字列を候補にします（かな・漢字・中黒・ローマ数字・英字: グウェル・オス・ガール、ギルザレンⅢ世、叶、IRyS、Gawr Gura）。名前の「かな部分」が読みに含まれない候補は機械的に落とします。
3. 検索結果を根拠 (`state`) として Jev に 1 回だけ問い合わせます。同じ呼び出しに次を並べます。
   - `who` (Choice): どの候補がその読みの VTuber か。
   - 候補ごとの `is_vtuber` (Noul): VTuber か。芸能人・一般人・地名を弾きます。
   - 候補ごとの `reading_match` (Noul): 名前全体の読みが入力と一致するか。断片を弾きます。
4. `who × is_vtuber × reading_match` が閾値以上の最上位を返します。無ければ「見つかりませんでした」。

Jev は文字列を生成せず、与えた選択肢に対する確率だけを返すモデルです。ここでは「検索結果を読んで判断する」役だけをさせています。

## セットアップ

```sh
npm install
cp .env.example .env   # TYPESAFE_API_KEY と、検索プロバイダの鍵をどれか 1 つ
npm run dev -- -v きねつきのあ
```

検索プロバイダの鍵の取り方は `.env.example` に書いてあります。鍵が無い場合は Wikipedia 検索にフォールバックしますが、大手しか載っていないので実用にはなりません。

## ライブラリとして使う

```ts
import { Resolver, TypeSafeJev, SearchChain, providersFromEnv } from "jev-vtuber-ime-core";

const resolver = new Resolver({
  jev: new TypeSafeJev({ apiKey: env.TYPESAFE_API_KEY }),
  search: new SearchChain(providersFromEnv(env)),
});
const r = await resolver.resolve("きねつきのあ");
r.best?.name; // "杵月のあ" | undefined
```

`JevClient` は `systemOne(state, questions)` だけのインターフェースなので、Cloudflare Workers AI の `typesafe/jev` バインディングなど別経路の実装を渡せます。`SearchProvider` も同様に差し替え可能です。

## ライセンス

MIT
