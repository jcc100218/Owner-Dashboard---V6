/* Account-bound Empire evidence. Never install portfolio data into the active
 * league bridge. Value/assessment formulas remain owned by canonical shared. */
(function () {
    'use strict';
    const App = window.App = window.App || {};
    const idOf = league => String(league?.id || league?.league_id || '');
    const providerOf = league => league?._espn || idOf(league).startsWith('espn_') ? 'espn'
        : league?._mfl || idOf(league).startsWith('mfl_') ? 'mfl'
            : league?._yahoo || idOf(league).startsWith('yahoo_') ? 'yahoo' : /^\d+$/.test(idOf(league)) ? 'sleeper' : 'unknown';
    const unavailable = reason => ({ status: 'unavailable', reason });
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    function normalizeStats(raw, scoring, historical) {
        if (!object(raw) || !object(scoring) || !Object.keys(scoring).length || typeof App.calcRawPts !== 'function') return {};
        const out = {};
        Object.entries(raw).forEach(([pid, row]) => {
            const gp = Number(row?.gp);
            if (!object(row) || !Number.isFinite(gp) || gp <= 0) return;
            const points = App.calcRawPts(row, scoring);
            if (!Number.isFinite(points)) return;
            out[pid] = historical ? { prevAvg: Math.round(points / gp * 10) / 10, prevTotal: points, prevRawStats: row }
                : { seasonAvg: Math.round(points / gp * 10) / 10, seasonTotal: points };
        });
        return out;
    }
    async function load(options) {
        const identity = options.identity || App.PublicPortfolio.capture();
        const active = () => App.PublicPortfolio.current(identity) && (!options.isCurrent || options.isCurrent());
        const check = () => { if (!active()) throw new Error('Empire account or league context changed.'); };
        const run = async work => {
            check(); let timer;
            try {
                const value = await Promise.race([Promise.resolve().then(() => { check(); return work(); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The request timed out. Retry Empire sync.')), options.timeoutMs || 20000); })]);
                check(); return value;
            } finally { clearTimeout(timer); }
        };
        const read = url => run(async () => { const response = await window.fetch(url); check(); if (!response.ok) throw new Error('Provider request failed (' + response.status + ').'); const value = await response.json(); check(); return value; });
        const status = { players: { status: 'loading' }, status: 'loading', completed: 0, total: options.leagues.length };
        let players = options.players || {};
        const leagues = options.leagues.map(league => ({ ...league, rosters: (league.rosters || []).map(r => ({ ...r, players: Array.isArray(r.players) ? r.players.slice() : r.players })),
            empireAssessments: [], empireDna: {}, empirePickState: null,
            empireEvidence: { picks: { status: 'loading' }, stats: { status: 'loading' }, dna: { status: 'loading' }, assessments: { status: 'loading' } } }));
        const publish = () => { check(); const result = { players, leagues: leagues.slice(), status: { ...status } }; options.onProgress?.(result); return result; };
        publish();
        try {
            if (!Object.keys(players).length) players = await run(() => App.fetchAllPlayers());
            if (!object(players) || !Object.keys(players).length) throw new Error('Player metadata is unavailable.');
            status.players = { status: 'ready' };
        } catch (error) { check(); players = {}; status.players = unavailable(error.message); }
        publish();
        const rawStats = new Map();
        const statsFor = season => {
            if (!rawStats.has(season)) rawStats.set(season, run(() => {
                if (typeof window.fetchSeasonStats !== 'function') throw new Error('Season statistics are unavailable.');
                return window.fetchSeasonStats(String(season));
            }));
            return rawStats.get(season);
        };
        for (let index = 0; index < leagues.length; index++) {
            check(); const league = leagues[index], source = providerOf(league), evidence = league.empireEvidence;
            const rostersKnown = league.rosters.length > 0 && league.rosters.every(r => Array.isArray(r.players));
            let picksRaw = null, pickState = null;
            try {
                if (!rostersKnown || league._portfolioStale) throw new Error('Current roster holdings are unavailable. Refresh league sync.');
                if (!App.TradePickInventory) throw new Error('The verified draft-ownership adapter has not loaded.');
                picksRaw = await run(() => App.TradePickInventory.load(league, league.rosters));
                pickState = App.TradePickInventory.inventory(league, league.rosters, picksRaw);
                evidence.picks = { status: pickState.status === 'ready' && pickState.coverage.complete ? 'ready' : 'unavailable', ...pickState.coverage };
                league.empirePickState = pickState;
                if (picksRaw.status === 'ready') {
                    league.drafts = picksRaw.league.drafts;
                    league.tradedPicks = picksRaw.tradedPicks;
                } else delete league.tradedPicks;
            } catch (error) { check(); evidence.picks = unavailable(error.message); delete league.tradedPicks; }
            check();
            let stats = {};
            try {
                const year = Number(league.season);
                if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error('The league season is unavailable.');
                const raw = await statsFor(year); check();
                if (!object(raw)) throw new Error('Season statistics are incomplete.');
                stats = normalizeStats(raw, league.scoring_settings, false);
                evidence.stats = { status: Object.keys(stats).length ? 'ready' : 'unavailable', season: String(year), basis: 'current-season' };
                // Preserve the established offseason historical basis explicitly.
                // An outage is not an empty successful season and never falls back.
                if (!Object.keys(raw).length) {
                    const prior = await statsFor(year - 1); check();
                    stats = normalizeStats(prior, league.scoring_settings, true);
                    evidence.stats = { status: Object.keys(stats).length ? 'historical' : 'unavailable', season: String(year - 1), requestedSeason: String(year), basis: 'prior-season' };
                }
            } catch (error) { check(); evidence.stats = unavailable(error.message); }
            check();
            // Do not feed missing rights, seasonal dynasty assumptions, raw stat
            // fields or an absent value engine into a confident health/tier read.
            if (rostersKnown && !league._portfolioStale && evidence.picks.status === 'ready' && pickState?.coverage.format === 'dynasty'
                && source === 'sleeper' && Object.keys(stats).length && App.LI_LOADED && Object.keys(App.LI?.playerScores || {}).length && typeof App.assessAllTeams === 'function') {
                try {
                    const result = App.assessAllTeams(league.rosters, players, stats, { ...league, drafts: picksRaw.league.drafts }, league.users || [], picksRaw.tradedPicks);
                    check(); if (!Array.isArray(result) || result.length !== league.rosters.length) throw new Error('Team assessments are incomplete.');
                    league.empireAssessments = result;
                    evidence.assessments = { status: 'ready', stats: { ...evidence.stats }, valueBasis: 'loaded-league-proxy' };
                } catch (error) { check(); evidence.assessments = unavailable(error.message); }
            } else evidence.assessments = unavailable('Team reads need verified dynasty rights, roster holdings, scored season data and the value engine.');
            publish();
            // Read the current principal's saved cloud DNA directly. The legacy
            // OD.loadDNA reader writes unscoped local cache after its await.
            let saved = {}, transactions = [], savedReady = false, transactionReady = false;
            try {
                check();
                const token = window.OD?.getSessionToken?.(), owner = window.getOwnerIdentity?.();
                const db = token && (owner?.userId || owner?.username) && window.OD?.getClient?.();
                if (!db) throw new Error('Saved owner notes require a current account connection.');
                let query = db.from('owner_dna').select('dna_map');
                query = owner.userId ? query.eq('user_id', owner.userId) : query.eq('username', owner.username);
                const reply = await run(() => query.eq('league_id', idOf(league)).maybeSingle());
                if (reply.error || (reply.data?.dna_map != null && !object(reply.data.dna_map))) throw new Error('Saved owner notes could not load.');
                saved = reply.data?.dna_map || {}; savedReady = true;
            } catch (error) { check(); evidence.dna = unavailable(error.message); }
            try {
                if (source === 'sleeper') {
                    // League IDs identify their season; explicit league URLs avoid
                    // WrTxns' implicit active-season context and failure-to-[] cache.
                    for (let week = 0; week <= 18; week++) {
                        const rows = await read('https://api.sleeper.app/v1/league/' + idOf(league) + '/transactions/' + week);
                        if (!Array.isArray(rows) || rows.some(row => !object(row) || !['trade', 'waiver', 'free_agent'].includes(row.type)
                            || typeof row.status !== 'string' || !row.status.trim()
                            || (row.league_id && String(row.league_id) !== idOf(league)))) throw new Error('League transaction evidence is incomplete.');
                        transactions.push(...rows.filter(row => row.status === 'complete'));
                    }
                    transactionReady = true;
                } else if (league.transactionStatus?.status === 'ready' && String(league.transactionStatus.leagueId) === idOf(league) && String(league.transactionStatus.season) === String(league.season) && Array.isArray(league.transactions)) {
                    transactions = league.transactions; transactionReady = true;
                }
            } catch (error) { check(); transactions = []; evidence.transactions = unavailable(error.message); }
            check();
            if (savedReady || transactionReady) league.empireDna = App.buildEmpireDna?.(saved, transactionReady ? transactions : [], league.rosters, options.sleeperUserId) || saved;
            evidence.dna = { status: savedReady && transactionReady ? 'ready' : 'partial', savedNotes: savedReady ? 'ready' : 'unavailable', transactions: transactionReady ? 'ready' : 'unavailable' };
            evidence.transactions = transactionReady ? { status: 'ready', provider: source, leagueId: idOf(league), season: String(league.season) } : (evidence.transactions || league.transactionStatus || unavailable('Provider transaction history has not been verified.'));
            status.completed++; publish();
        }
        status.status = 'ready'; return publish();
    }
    App.PublicEmpire = { load, normalizeStats, providerOf };
})();
