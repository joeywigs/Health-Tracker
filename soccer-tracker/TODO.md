# Pending front-end changes (blocked on recovering public/app.js)

Requested 2026-08-29. All are UI changes in the front end; the API and D1
schema already support them (player_number is nullable, event `type` is
free-form). Implement once `public/` is restored (see README).

## 1. No player-number entry for opposing-team events

When recording any event for the opposing team ("them"), skip the jersey
number prompt entirely. Player attribution is only collected for our team.

## 2. Event-dot colors follow who gets the restart

For a shot that is off target (by either team) where the result is a
**goal kick**: the goal-kick dot takes the **defending team's** color
(the team awarded the goal kick).

For a **save**: the dot takes the **defending team's** color (the team
whose goalie made the save).

## 3. New "goalie deflection" option

Add a goalie-deflection outcome for a shot: the goalie tips the ball out
and the **attacking team** (the team that took the shot) is awarded a
**corner kick**. The dot takes the **attacking team's** color.
