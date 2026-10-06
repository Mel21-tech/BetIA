// Client api-tennis.com (doc : https://api-tennis.com/documentation/).
// Toutes les requêtes passent par https://api.api-tennis.com/tennis/?method=...&APIkey=...
// La clé est lue depuis l'environnement (secret GitHub), jamais écrite dans le code.
const BASE = "https://api.api-tennis.com/tennis/";
const SINGLES = /^(Atp|Wta) Singles$|^Challenger (Men|Women) Singles$/i;

export function createTennisClient(apiKey, { fetchImpl = fetch } = {}) {
  const memo = new Map(); // cache pendant l'exécution : un joueur/tournoi n'est jamais demandé deux fois
  let calls = 0;

  async function call(params) {
    const key = JSON.stringify(params);
    if (memo.has(key)) return memo.get(key);
    calls++;
    const url = BASE + "?" + new URLSearchParams({ ...params, APIkey: apiKey }).toString();
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`api-tennis ${params.method} : HTTP ${res.status}`);
    const data = await res.json();
    if (!data || Number(data.success) !== 1) {
      throw new Error(`api-tennis ${params.method} : ${JSON.stringify(data && (data.error || data.result || data)).slice(0, 200)}`);
    }
    memo.set(key, data.result);
    return data.result;
  }

  // Matchs de simple (ATP, WTA, Challenger) sur une plage de dates. C'est d'ici que viennent les identifiants
  // des joueurs : l'API ne propose pas de recherche par nom.
  async function getFixtures(dateStart, dateStop) {
    const list = await call({ method: "get_fixtures", date_start: dateStart, date_stop: dateStop, timezone: "Europe/Paris" });
    return (list || []).filter((f) => SINGLES.test(f.event_type_type || ""));
  }

  // get_H2H renvoie les confrontations directes ET les derniers matchs de chaque joueur : un seul appel
  // alimente la forme, la fraîcheur et le face-à-face.
  async function getH2H(p1Key, p2Key) {
    const r = await call({ method: "get_H2H", first_player_key: p1Key, second_player_key: p2Key });
    return { h2h: r.H2H || [], first: r.firstPlayerResults || [], second: r.secondPlayerResults || [] };
  }

  // Forme : V/D sur les 10 derniers matchs de simple terminés, date du dernier match (fraîcheur).
  function lastMatches(playerKey, results, last = 10) {
    const done = results
      .filter((m) => m.event_status === "Finished" && m.event_winner && SINGLES.test(m.event_type_type || ""))
      .sort((a, b) => (b.event_date + b.event_time).localeCompare(a.event_date + a.event_time))
      .slice(0, last);
    let wins = 0;
    done.forEach((m) => { if (didWin(m, playerKey)) wins++; });
    return { wins, losses: done.length - wins, n: done.length, lastDate: done[0] ? done[0].event_date : null };
  }

  function h2hSummary(p1Key, list) {
    const done = list.filter((m) => m.event_status === "Finished" && m.event_winner);
    let p1Wins = 0;
    done.forEach((m) => { if (didWin(m, p1Key)) p1Wins++; });
    return {
      p1Wins, p2Wins: done.length - p1Wins, total: done.length,
      last: done.slice(0, 5).map((m) => ({ date: m.event_date, tournament: m.tournament_name, result: m.event_final_result,
        winnerKey: m.event_winner === "First Player" ? String(m.first_player_key) : String(m.second_player_key) })),
    };
  }

  // Surface : V/D en simple sur la surface, saison en cours + saison précédente (≈ 12 derniers mois ; l'API
  // fournit les bilans par saison, pas par date).
  async function getSurfaceStats(playerKey, surface) {
    const s = String(surface || "").toLowerCase();
    const field = s.includes("clay") ? "clay" : s.includes("grass") ? "grass" : s.includes("hard") ? "hard" : null;
    if (!field) return null;
    const list = await call({ method: "get_players", player_key: playerKey });
    const player = (list || [])[0];
    if (!player || !player.stats) return null;
    const year = new Date().getFullYear();
    let won = 0, lost = 0;
    player.stats
      .filter((st) => st.type === "singles" && (Number(st.season) === year || Number(st.season) === year - 1))
      .forEach((st) => { won += Number(st[field + "_won"]) || 0; lost += Number(st[field + "_lost"]) || 0; });
    return { surface: field, won, lost, seasons: `${year - 1}-${year}` };
  }

  // Service vs retour : agrège les statistiques réelles de ses matchs des 90 derniers jours (renvoyées
  // directement dans get_fixtures). Les noms de stats sont ceux de l'API, sans réinterprétation.
  async function getPlayerServeStats(playerKey) {
    const stop = new Date(), start = new Date(Date.now() - 90 * 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const list = await call({ method: "get_fixtures", player_key: playerKey, date_start: iso(start), date_stop: iso(stop) });
    const agg = {};
    (list || []).forEach((m) => (m.statistics || []).forEach((st) => {
      if (String(st.player_key) !== String(playerKey) || st.stat_period !== "match") return;
      const a = agg[st.stat_name] || (agg[st.stat_name] = { won: 0, total: 0, sum: 0, count: 0, kind: st.stat_type });
      if (st.stat_won != null && st.stat_total != null) { a.won += Number(st.stat_won) || 0; a.total += Number(st.stat_total) || 0; }
      else if (st.stat_value != null && st.stat_value !== "") { a.sum += parseFloat(String(st.stat_value)) || 0; a.count++; }
    }));
    const out = {};
    Object.keys(agg).forEach((name) => {
      const a = agg[name];
      if (a.total > 0) out[name] = { kind: a.kind, pct: a.won / a.total, won: a.won, total: a.total };
      else if (a.count > 0) out[name] = { kind: a.kind, avg: a.sum / a.count, matches: a.count };
    });
    return Object.keys(out).length ? out : null;
  }

  // Surface du tournoi : get_draw est le seul endpoint qui la renvoie (un appel par tournoi, mis en cache).
  async function getTournamentSurface(tournamentKey, season) {
    try {
      const r = await call({ method: "get_draw", tournament_key: tournamentKey, tournament_season: season });
      return (r && r.tournament && r.tournament.tournament_surface) || null;
    } catch (e) { return null; }
  }

  return { getFixtures, getH2H, lastMatches, h2hSummary, getSurfaceStats, getPlayerServeStats, getTournamentSurface,
    get calls() { return calls; } };
}

function didWin(m, playerKey) {
  const first = String(m.first_player_key) === String(playerKey);
  return (m.event_winner === "First Player") === first;
}
