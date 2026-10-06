// Client API-Football v3 (doc : https://www.api-football.com/documentation-v3).
// Plan gratuit : 100 requêtes/jour → budget strict par exécution, et un seul passage par jour (6 h).
const BASE = "https://v3.football.api-sports.io";

// Championnats suivis (identifiants API-Football) : Ligue 1, Premier League, Liga, Bundesliga, Serie A,
// Ligue des champions, Ligue Europa, Ligue des nations.
export const FOLLOWED_LEAGUES = [61, 39, 140, 78, 135, 2, 3, 5];

export function createFootballClient(apiKey, { fetchImpl = fetch, budget = 95 } = {}) {
  let calls = 0;
  async function call(path) {
    if (calls >= budget) throw new Error("Budget API-Football du jour atteint");
    calls++;
    const res = await fetchImpl(BASE + path, {
      headers: { "x-apisports-key": apiKey, "x-rapidapi-host": "v3.football.api-sports.io" },
    });
    if (!res.ok) throw new Error(`API-Football ${path} : HTTP ${res.status}`);
    const data = await res.json();
    // Quota dépassé, clé invalide ou saison non couverte par le plan : l'API répond 200 avec "errors".
    const errs = data && data.errors;
    if (errs && ((Array.isArray(errs) && errs.length) || (!Array.isArray(errs) && Object.keys(errs).length))) {
      throw new Error("API-Football : " + JSON.stringify(errs).slice(0, 200));
    }
    return data.response || [];
  }

  async function getFixturesByDate(date) {
    const list = await call(`/fixtures?date=${date}&timezone=Europe/Paris`);
    return list.filter((f) => FOLLOWED_LEAGUES.includes(f.league.id));
  }

  // Prédictions API-Football : contient la forme (5 derniers), les bilans domicile/extérieur, le H2H et
  // leurs propres pourcentages — un seul appel couvre forme, domicile/extérieur et face-à-face.
  async function getPredictions(fixtureId) {
    const r = (await call(`/predictions?fixture=${fixtureId}`))[0];
    if (!r) return null;
    const side = (t) => {
      const lg = (t && t.league) || {};
      const fx = lg.fixtures || {};
      return {
        form: String(lg.form || "").slice(-5),
        playedHome: Number(fx.played && fx.played.home) || 0, winsHome: Number(fx.wins && fx.wins.home) || 0,
        playedAway: Number(fx.played && fx.played.away) || 0, winsAway: Number(fx.wins && fx.wins.away) || 0,
      };
    };
    const homeId = r.teams.home.id;
    let homeWins = 0, awayWins = 0, draws = 0;
    (r.h2h || []).forEach((f) => {
      const gh = f.goals.home, ga = f.goals.away;
      if (gh == null || ga == null) return;
      if (gh === ga) { draws++; return; }
      const homeSideWon = gh > ga;
      const homeSideIsOurHome = f.teams.home.id === homeId;
      if (homeSideWon === homeSideIsOurHome) homeWins++; else awayWins++;
    });
    const pct = (r.predictions && r.predictions.percent) || {};
    return {
      home: side(r.teams.home), away: side(r.teams.away),
      h2h: { homeWins, awayWins, draws, total: homeWins + awayWins + draws },
      percent: { home: parseFloat(pct.home) / 100 || null, draw: parseFloat(pct.draw) / 100 || null, away: parseFloat(pct.away) / 100 || null },
      advice: (r.predictions && r.predictions.advice) || null,
    };
  }

  // Calendrier & fraîcheur : date du dernier match joué.
  async function getLastFixtureDate(teamId) {
    const f = (await call(`/fixtures?team=${teamId}&last=1`))[0];
    return f ? f.fixture.date : null;
  }

  // Absents (blessés/suspendus) du match.
  async function getInjuries(fixtureId) {
    const list = await call(`/injuries?fixture=${fixtureId}`);
    return list.map((i) => ({ teamId: i.team.id, player: i.player.name, reason: i.player.reason || i.player.type || "" }));
  }

  return { getFixturesByDate, getPredictions, getLastFixtureDate, getInjuries, get calls() { return calls; } };
}
