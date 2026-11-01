# Page convention

This file is for the authors of HTML pages that people review with the review panel: people and agents.
A page that follows it lets the panel do three things:

1. Save the place of each note: the slide, the step, the section.
2. Open that place again ("open here").
3. Attach the right element on Alt+click.

A page that does nothing of this still works. The panel then takes the place from the headings, and Alt+click attaches the element under the cursor.

## 1. Place

A place has two parts:

- `where`: a short text for people and for the agent, for example `slide 12 · Binary search · step 3`.
- `hash`: the URL fragment that opens the same place, for example `12.3`.

A note keeps both in `ctx.where` and `ctx.hash`.

### A page that scrolls

Give each section an `id`, on the heading or on its `<section>` or `<article>`:

```html
<section id="hash-tables">
  <h2>Hash tables</h2>
  ...
</section>
```

Nothing else is needed. The panel takes the last visible heading in the upper quarter of the window:
`where` is the text of the heading, `hash` is the `id` of the heading or of its `<section>`/`<article>`.
To open a place, the panel scrolls to the element with this `id`.

### A page that shows one place at a time

Slides, steps, tabs and animations are states that the scroll position does not show. Such a page defines `window.reviewState()`:

```js
window.reviewState = () => ({
  where: `slide ${slide + 1} · ${title} · step ${step}`,
  hash: `${slide + 1}.${step}`,
});
```

- Put the most general part of `where` first: the slide, then the step.
- `hash` opens the same place, the step included. A `#` at the start is optional.
- Give the same `hash` for the same place every time.
- Before the page is ready, return `{}`.

When `window.reviewState` is defined, the panel does not look at the headings.

## 2. Open a place

A page with `reviewState()` opens the place that `location.hash` names:

- on load;
- on each `hashchange` event.

```js
const openHash = () => open(decodeURIComponent(location.hash.slice(1)));
openHash();
addEventListener('hashchange', openHash);
```

Ignore a hash that names no place.

"Open here" works so:

1. The panel sets `location.hash`. If the hash is already the same, the panel sends a `hashchange` event: open the place again,
   for example, go back to the step.
2. After 300 ms the panel compares `reviewState().hash` with the hash of the note. If they are different, the panel reloads the page,
   and the page opens the place on load.

So a page with no `hashchange` handler also works, but it reloads each time.

## 3. Elements

On Alt+click the panel attaches the element under the cursor: the target of the click.
In an SVG it takes the nearest `<text>`, `<g>` or `[data-review]` element around the shape.

The note keeps in `el`:

- `text`: the text of the element, up to 160 characters (for an image, its `alt`);
- `path`: up to 4 elements from the attached one up, for example `section#search > ol.steps > li[step].done`;
- `point`: the click point in the window;
- `stack`: the elements under the point, the topmost first.

Each element of a path is `tag#id[name].class1.class2.class3`: the `id`, the `data-review` name and up to 3 classes.

Rules:

- **Put each part that a person can comment on in its own element.** A click on text in a container picks the container.
  In `<div class="card"><b>O(n)</b> time for each query</div>`, a click on "time for each query" picks the whole card.
  Write `<div class="card"><b>O(n)</b> <span>time for each query</span></div>`.
- **Let clicks go through layers that are not content.** A decoration, a transparent layer or a hit area over the content
  takes the click, and the panel attaches it. Give such a layer `pointer-events: none`.
- **Name the parts that repeat** with `data-review="<name>"`: `<li data-review="step">`. The name is in the path,
  so the agent finds the element in the source. Give a part that does not repeat an `id`.
- **Group an SVG shape with its label** in a `<g>`, so that a click on the shape or on the label picks both.
  Put `data-review` on the `<g>` to name it.
- **Put the meaningful class first.** The path shows only the first 3 classes of each element.

## 4. Do not use

The panel uses these clicks and names. Do not give them another meaning on the page:

- `Alt+click`: it attaches an element, and the page does not get the click;
- the element `<review-panel>` and the attribute `data-review-picked`;
- `window.reviewState`: define it only as section 1 says.

The panel stops the keys, the clicks and the wheel turns that are made in the panel, so a page does not react to them.

## Checklist

- [ ] A page that scrolls: each section has an `id`.
- [ ] A page that shows one place at a time: `window.reviewState()` gives `{where, hash}`, and the page opens the place from the hash on load and on `hashchange`.
- [ ] Each text that a person can comment on is in its own element.
- [ ] Layers over the content have `pointer-events: none`.
- [ ] Parts that repeat have `data-review` names; SVG shapes and their labels are grouped in `<g>`.
