---
"@sapiom/harness": minor
---

Studio: the project map draws your groups as named containers, instead of one
endless column of agents.

A project map used to draw every agent it contained as one flat set, ignoring
the structure the rail was showing right beside it. Open a folder holding
several systems and you got a single vertical column — a nine-system, 76-agent
folder came out 9,700 pixels tall and one card wide, which no amount of zooming
out makes readable.

- **One labelled container per group.** The map now reads the same groups the
  rail does, so a system you named in the rail is a system you can see on the
  map, under exactly that name and in the same order. Rename or regroup in the
  rail and the map follows immediately.
- **Ungrouped is a container too.** "No connections detected" is a real answer
  about a project, not an absence, so it gets a labelled box rather than being
  scattered loose. A project with one group renders as one group.
- **Agents with no connections wrap instead of stacking.** Inside a container,
  unconnected agents fill the width and wrap, which is what replaces the column.
- **A connector between two containers is still drawn.** Splitting a system
  across two groups does not make the link between the halves disappear; it is
  drawn dotted, as a link between systems rather than wiring inside one.
- Container names stay readable as you zoom out, which is the moment you are
  looking at the whole project and need to know which system is which.

Nothing about how groups are detected, edited, or stored has changed. The map is
a new reader of the arrangement your project already has; it never writes one.
