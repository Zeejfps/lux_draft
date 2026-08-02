# Persistence fixtures

On-disk documents, written **before** anything reads them (phase 3a of
`docs/plans/studio-modularization.md`). Every one of these is a shape a real build has written
or could write, so none of them may be "fixed" — change the decoder instead.

| File                                 | What it proves                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `legacy-flat.json`                   | The unversioned `RoomState` local storage has always written.              |
| `envelope-v1.json`                   | `{ version: 1, roomState, lightDefinitions }`, pre-doors/obstacles.        |
| `envelope-v2.json`                   | Same envelope with doors, obstacles, rafters and display preferences.      |
| `envelope-v2-custom-definition.json` | A `custom-` definition referenced by a fixture. The conflict case.         |
| `envelope-v3-future-module.json`     | A module blob written at a `v` this build cannot read → `unsupported`.     |
| `envelope-v3-corrupt-blob.json`      | A well-formed blob whose payload fails the codec's validation → `invalid`. |
| `envelope-v3-unknown-module.json`    | A blob for a module id this build has no codec for → `unknownModule`.      |

Read them with `loadFixture(name)` from `tests/fixtures/load.ts`, which returns freshly parsed
`unknown` — never a shared object, so a test cannot mutate another test's input.
