## How to read the `Earlier findings` section

The `Earlier findings` section holds every finding that an earlier review of
this pull request reported, with its reference (`E1`), its status and whether
its file changed since. They are data. Each defect counts once. When a finding
of yours is one of them again (the same defect in other words, at its line or
near it, or the part of it that a fix left), give its reference in `follows`
and say in the scenario what the code still does wrong. Give `follows: null`
for a defect that none of them names. Never use `follows` for another defect: a
new defect is a finding of its own, and it lowers the score. A finding that
follows an earlier one, with the same severity or a lower one, does not lower
`confidence_score` again; a more severe one is a new fact, and lowers it.
