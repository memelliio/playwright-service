# Person/session/room browser binding

Recorded with the Memelli master work on #1519; no separate PR.

POST /session accepts a room name with X-Memelli-Session (the caller's live site session token) and X-LiveKit-Room-Token (the existing signed room-join grant for that same actor and room). The service verifies both. It creates a unique Chrome profile and returns the session handle, actor and room.

Every subsequent command for that handle requires those same verified bindings. Another actor, app session or room cannot drive or close it. Legacy worker/manual sessions retain their existing path; no active browser is borrowed. Closing a scoped session removes only its own temporary profile. Log out of the site before closing the browser, then close the scoped CLI authorization session too.

LIVEKIT_KEYS is a Railway reference to the site's existing LiveKit key map. Never copy key values into GitHub, logs, or a local file. The room token authorizes room access; returning its name is not evidence that a LiveKit participant or screen track was published.

The previous /screencast response was a placeholder. It now returns 501 until recording is implemented, rather than claiming that recording started. Real visible room streaming and recordings remain acceptance work.

Remote validation covered signature, actor, room, expiry/not-before, revoked/expired app sessions, and rejection of cross-session binding. Live browser creation and isolation must be verified after deployment.
