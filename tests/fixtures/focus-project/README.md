# Focus timer

Open index.html directly in a browser. No server, installation, network or dependencies are needed.

Name a session, Start, Pause or resume it. Reset timer clears the current timer without completing a session or changing completed totals. Finish session adds positive elapsed time to the completed count and total, then resets and pauses the current timer. Repeated Finish with no elapsed time does nothing.

All state lasts for the current page session only: refresh resets the timer, completed count and total. There is no saved history.

With stable Node 26.12.1 (or a validated eligible 26.x runtime):

    node --test --test-isolation=none --test-reporter=tap focus.test.mjs
