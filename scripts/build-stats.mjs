// Batch quotidien (GitHub Actions, 6 h) : récupère les stats réelles et écrit data/stats.json.
// Les clés viennent UNIQUEMENT des secrets (variables d'environnement) et n'apparaissent jamais dans
// le fichier produit, qui ne contient que des statistiques.
import { writeFile, mkdir } from "node:fs/promises";
import { createTennisClient } from "./lib/tennisData.mjs";
import { createFootballClient } from "./lib/footballData.mjs";

const TENNIS_MAX_MATCHES = 120;
const FOOTBALL_MAX_MATCHES = 20; // ~4 appels par match → reste sous les 100 requêtes/jour du plan gratuit

const parisDate = (offsetDays = 0) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" })
  .format(new Date(Date.now() + offsetDays * 86400000));

export async function buildTennis(apiKey, opts = {}) {
  if (!apiKey) return { matches: [], error: "Secret API_TENNIS_KEY absent" };
  const api = createTennisClient(apiKey, opts);
  const out = [];
  try {
    const fixtures = (await api.getFixtures(parisDate(0), parisDate(1)))
      .filter((f) => f.event_status !== "Finished" && f.event_status !== "Cancelled")
      .slice(0, TENNIS_MAX_MATCHES);
    for (const f of fixtures) {
      const p1 = String(f.first_player_key), p2 = String(f.second_player_key);
      const entry = { matchKey: f.event_key, date: f.event_date, time: f.event_time, tournament: f.tournament_name,
        p1: { key: p1, name: f.event_first_player }, p2: { key: p2, name: f.event_second_player },
        surface: null, form: {}, surfaceStats: {}, serve: {}, h2h: null, errors: [] };
      try {
        const h = await api.getH2H(p1, p2);
        entry.form[p1] = api.lastMatches(p1, h.first);
        entry.form[p2] = api.lastMatches(p2, h.second);
        entry.h2h = api.h2hSummary(p1, h.h2h);
      } catch (e) { entry.errors.push(String(e.message || e)); }
      entry.surface = await api.getTournamentSurface(f.tournament_key, f.tournament_season);
      for (const pk of [p1, p2]) {
        try { entry.surfaceStats[pk] = await api.getSurfaceStats(pk, entry.surface); } catch (e) { entry.errors.push(String(e.message || e)); }
        try { entry.serve[pk] = await api.getPlayerServeStats(pk); } catch (e) { entry.errors.push(String(e.message || e)); }
      }
      out.push(entry);
    }
    return { matches: out, error: null, calls: api.calls };
  } catch (e) {
    return { matches: out, error: String(e.message || e), calls: api.calls };
  }
}

export async function buildFootball(apiKey, opts = {}) {
  if (!apiKey) return { matches: [], error: "Secret API_FOOTBALL_KEY absent" };
  const api = createFootballClient(apiKey, opts);
  const out = [];
  try {
    const fixtures = [...(await api.getFixturesByDate(parisDate(0))), ...(await api.getFixturesByDate(parisDate(1)))]
      .filter((f) => ["NS", "TBD"].includes(f.fixture.status.short))
      .slice(0, FOOTBALL_MAX_MATCHES);
    for (const f of fixtures) {
      const entry = { fixtureId: f.fixture.id, date: f.fixture.date, league: f.league.name,
        home: { id: f.teams.home.id, name: f.teams.home.name }, away: { id: f.teams.away.id, name: f.teams.away.name },
        prediction: null, rest: {}, injuries: [], errors: [] };
      try { entry.prediction = await api.getPredictions(f.fixture.id); } catch (e) { entry.errors.push(String(e.message || e)); }
      try { entry.rest.home = await api.getLastFixtureDate(f.teams.home.id); } catch (e) { entry.errors.push(String(e.message || e)); }
      try { entry.rest.away = await api.getLastFixtureDate(f.teams.away.id); } catch (e) { entry.errors.push(String(e.message || e)); }
      try { entry.injuries = await api.getInjuries(f.fixture.id); } catch (e) { entry.errors.push(String(e.message || e)); }
      out.push(entry);
      if (entry.errors.some((m) => m.includes("Budget"))) break;
    }
    return { matches: out, error: null, calls: api.calls };
  } catch (e) {
    return { matches: out, error: String(e.message || e), calls: api.calls };
  }
}

async function main() {
  const [tennis, football] = await Promise.all([
    buildTennis(process.env.API_TENNIS_KEY),
    buildFootball(process.env.API_FOOTBALL_KEY),
  ]);
  const payload = { generatedAt: new Date().toISOString(), tennis, football };
  await mkdir("data", { recursive: true });
  await writeFile("data/stats.json", JSON.stringify(payload));
  console.log(`Tennis : ${tennis.matches.length} match(s), ${tennis.calls ?? 0} appel(s)${tennis.error ? " — ERREUR : " + tennis.error : ""}`);
  console.log(`Foot : ${football.matches.length} match(s), ${football.calls ?? 0} appel(s)${football.error ? " — ERREUR : " + football.error : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
