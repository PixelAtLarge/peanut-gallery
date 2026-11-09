import { LABELS } from '@pixelatlarge/peanut-gallery-core';

export const WORKFLOW_PATH = '.github/workflows/peanut-gallery.yml';

/**
 * GitHub Actions workflow that runs the loop without anyone's laptop: new feedback becomes pull
 * requests, replies on a comparison are tallied, and a schedule catches anything missed.
 */
export function workflowYaml(opts: { feedbackLabel?: string; proposalLabel?: string; budget?: number; ref?: string } = {}): string {
  const feedback = opts.feedbackLabel ?? LABELS.feedback;
  const proposal = opts.proposalLabel ?? LABELS.proposal;
  return `# Peanut Gallery: turns reviewer feedback into pull requests, and tallies the votes.
# Needs one secret: CLAUDE_CODE_OAUTH_TOKEN (run \`claude setup-token\`), or ANTHROPIC_API_KEY.
name: Peanut Gallery

on:
  issues:
    types: [opened, labeled]
  issue_comment:
    types: [created]
  schedule:
    - cron: '17 */6 * * *' # every 6 hours: catch anything missed and tally votes
  workflow_dispatch:
    inputs:
      mode:
        description: What to run
        type: choice
        options: [both, review, votes]
        default: both

permissions:
  contents: write
  issues: write
  pull-requests: write

concurrency:
  group: peanut-gallery
  cancel-in-progress: false

jobs:
  peanut-gallery:
    # New feedback issues, replies on issues that have a proposal, schedules and manual runs.
    # Only people who can triage the repo can label issues, so outsiders can't start agent runs.
    if: >-
      github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'issues' && (
        (github.event.action == 'opened' && contains(github.event.issue.labels.*.name, '${feedback}')) ||
        (github.event.action == 'labeled' && github.event.label.name == '${feedback}'))) ||
      (github.event_name == 'issue_comment' && !github.event.issue.pull_request &&
        contains(github.event.issue.labels.*.name, '${proposal}') && github.event.comment.user.type != 'Bot')
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: PixelAtLarge/peanut-gallery@${opts.ref ?? 'v0'}
        with:
          claude-code-oauth-token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          anthropic-api-key: \${{ secrets.ANTHROPIC_API_KEY }}
          mode: \${{ inputs.mode || 'auto' }}
          budget: ${opts.budget ?? 5}
`;
}
