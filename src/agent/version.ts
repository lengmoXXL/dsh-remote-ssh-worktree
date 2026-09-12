/**
 * The agent build this plugin installs on every machine it reaches.
 *
 * A single constant, not a config knob: the plugin and the release it
 * downloads are one artifact, and a plugin that let a deployment name a
 * different build would be describing a wire contract it cannot check. Bump
 * this together with the release tag and `agent/Cargo.toml`, which a unit test
 * keeps in step.
 *
 * @module dsh-remote-ssh-worktree/agent/version
 */

/** Agent build the plugin installs, matching the `v<version>` release tag. */
export const AGENT_VERSION = '0.0.1'

/** Agent protocol revision this plugin speaks. */
export const AGENT_PROTOCOL = 1
