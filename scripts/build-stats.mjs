name: BetIA - stats quotidiennes

on:
  schedule:
    # 04:00 UTC = 6 h à Paris en heure d'été (5 h en heure d'hiver).
    - cron: "0 4 * * *"
  workflow_dispatch: {}   # bouton "Run workflow" pour lancer à la main

permissions:
  contents: write

concurrency:
  group: betia-stats
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Récupérer les stats (clés lues depuis les secrets)
        env:
          API_TENNIS_KEY: ${{ secrets.API_TENNIS_KEY }}
          API_FOOTBALL_KEY: ${{ secrets.API_FOOTBALL_KEY }}
        run: node scripts/build-stats.mjs
      - name: Publier data/stats.json
        run: |
          git config user.name "betia-bot"
          git config user.email "betia-bot@users.noreply.github.com"
          git add data/stats.json
          git diff --cached --quiet || git commit -m "Stats du $(date -u +%Y-%m-%d)"
          git push
