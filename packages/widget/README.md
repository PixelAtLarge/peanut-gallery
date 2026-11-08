# @pixelatlarge/peanut-gallery-widget

Drop-in annotation layer for hosted prototypes. Reviewers click any element and leave a note; notes stay attached to the element and are filed as a GitHub issue. Part of [Peanut Gallery](https://github.com/PixelAtLarge/peanut-gallery), which turns that feedback into pull requests with Claude. [Try the demo](https://pixelatlarge.github.io/peanut-gallery/).

**Script tag (any page):**

```html
<script src="https://unpkg.com/@pixelatlarge/peanut-gallery-widget/dist/peanut-gallery.global.js"
        data-repo="owner/prototype-repo"
        data-activation="query"></script>
```

Open the page with `?peanut` in the URL and the toolbar appears.

**React:**

```tsx
import { PeanutGallery } from '@pixelatlarge/peanut-gallery-widget/react';

<PeanutGallery repo="owner/prototype-repo" />
```

**Programmatic:**

```ts
import { init } from '@pixelatlarge/peanut-gallery-widget';

init({ repo: 'owner/prototype-repo', relayUrl: 'https://example.com/api/peanut-gallery' });
```

All options (relay mode, activation, theming, `onSubmit`, preloaded notes) are in the [main README](https://github.com/PixelAtLarge/peanut-gallery#1-add-the-widget-to-the-prototype).

MIT licensed.
