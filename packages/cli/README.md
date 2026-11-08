# peanut-gallery

Prototype feedback in, pull requests out. This CLI reads reviewer notes from GitHub issues (left with [`@pixelatlarge/peanut-gallery-widget`](https://www.npmjs.com/package/@pixelatlarge/peanut-gallery-widget)), has Claude group them into proposals and implement each one on its own branch, captures before/after screenshots, opens a PR per change and tallies reviewers' votes.

[Watch the explainer and try the demo](https://github.com/PixelAtLarge/peanut-gallery#readme).

```bash
npm i -D peanut-gallery
npx peanut-gallery init      # config, labels, widget snippet
npx peanut-gallery review    # pull → interpret → confirm → apply
```

Needs Node 20+, the GitHub CLI (`gh`) signed in, and Claude: a Claude Code login or `ANTHROPIC_API_KEY`. Spending is capped with `--budget`. The agent can only edit files inside its own worktree, never secrets, CI, dependency manifests or your design-system tokens. See the [security model](https://github.com/PixelAtLarge/peanut-gallery#security-model).

MIT licensed.
