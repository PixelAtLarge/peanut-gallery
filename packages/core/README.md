# @peanut-gallery/core

Shared pieces of [Peanut Gallery](https://github.com/PixelAtLarge/peanut-gallery): types, DOM element anchoring (selector, text fingerprint and position fallbacks), the GitHub issue format for review sessions, and the theme. You usually get this as a dependency of `@peanut-gallery/widget`, `@peanut-gallery/relay` or the `peanut-gallery` CLI.

```ts
import { createAnchor, resolveAnchor, sessionToIssue, issueToSession } from '@peanut-gallery/core';
```

MIT licensed.
