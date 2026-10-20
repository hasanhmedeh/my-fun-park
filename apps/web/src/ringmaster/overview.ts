// The analytics: who plays, what they play, when, and the records.
import { ATTRACTION_IDS, isPlot, OVERVIEW_DAYS, ringmaster, type Overview, type OverviewDays } from '../account/api';
import { betterOf, formatStat, statLabel } from '../account/stats';
import { renderBarChart } from './charts';
import { dayLabel, duration, esc, num, onApiError, pct, plural, rideLabel, rideName, when } from './util';

const DAYS_KEY = 'ringmaster.days';

export class OverviewView {
  private days: OverviewDays = readDays();
  private data: Overview | null = null;
  private loading = false;

  constructor(private el: HTMLElement) {
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-days], [data-refresh]');
      if (!b) return;
      if (b.dataset.days) {
        this.days = Number(b.dataset.days) as OverviewDays;
        try {
          localStorage.setItem(DAYS_KEY, String(this.days));
        } catch {
          // private mode: the choice just isn't remembered
        }
      }
      void this.load();
    });
  }

  /** Live: the numbers again, quietly. */
  refresh() {
    void this.load();
  }

  show() {
    if (!this.data) this.el.innerHTML = `${this.headHtml()}<p class="empty">Counting the crowd…</p>`;
    void this.load();
  }

  private async load() {
    if (this.loading) return;
    this.loading = true;
    this.el.querySelector('[data-refresh]')?.setAttribute('aria-busy', 'true');
    try {
      this.data = await ringmaster.overview(this.days);
      this.render(this.data);
    } catch (err) {
      onApiError(err);
      this.el.querySelector('[data-refresh]')?.removeAttribute('aria-busy');
    } finally {
      this.loading = false;
    }
  }

  private headHtml(d?: Overview) {
    const range = OVERVIEW_DAYS.map((n) => `<button type="button" data-days="${n}" aria-pressed="${n === this.days}">${n} days</button>`).join('');
    const sub = d ? `Last ${d.days} days (UTC), from ${dayLabel(d.since)} · updated ${when(d.generatedAt)}` : 'The numbers across every member.';
    return `<div class="view-head"><div><h2 id="h-overview">Overview</h2><p class="muted">${esc(sub)}</p></div>
      <div class="view-tools"><div class="segmented" role="group" aria-label="Range">${range}</div>
      <button type="button" class="btn btn-ghost btn-small" data-refresh>↻ Refresh</button></div></div>`;
  }

  private render(d: Overview) {
    const closed = rides(d).filter((id) => !d.byRide[id].open);
    const notices = [
      d.park.underMaintenance
        ? `<strong>🛠️ The park is under maintenance:</strong> only staff can come in. ${esc(d.park.maintenanceMessage ?? '')} <a href="#gates">Park gates →</a>`
        : '',
      !d.park.open ? `<strong>🚧 The park is closed.</strong> ${esc(d.park.closedMessage ?? '')} <a href="#gates">Park gates →</a>` : '',
      closed.length ? `<strong>🔧 Under maintenance:</strong> ${closed.map((id) => esc(rideName(id))).join(', ')}. <a href="#attractions">Attractions →</a>` : '',
    ].filter(Boolean);
    const finished = d.rounds.completed + d.rounds.abandoned;

    const tile = (label: string, value: string, note: string) =>
      `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${value}</p><p class="tile-note">${note}</p></div>`;
    const tiles = [
      tile('Members', num(d.users.total), `+${num(d.users.newInRange)} in ${d.days} days · +${num(d.users.newToday)} today`),
      tile(
        'Signed up with Google',
        num(d.users.google ?? 0),
        `${num(d.users.total - (d.users.google ?? 0))} with email${d.users.googleLinked ? ` (${num(d.users.googleLinked)} linked Google since)` : ''} · ${pct(d.users.google ?? 0, d.users.total)} Google`,
      ),
      tile('Active players', num(d.users.activeInRange), `${num(d.users.activeToday)} today`),
      tile('Rounds played', num(d.rounds.inRange), `${num(d.rounds.today)} today · ${num(d.rounds.total)} all time`),
      tile('Completion rate', pct(d.rounds.completed, finished), `${num(d.rounds.abandoned)} left early, all time`),
      tile('Tickets handed out', num(d.tickets.ticketsSoldInRange), `${plural(d.tickets.purchasesInRange, 'pack', 'packs')} · ${num(d.tickets.purchasesToday)} today`),
      tile('Tickets spent', num(d.tickets.ticketsSpentInRange), `${num(d.tickets.ticketsSpent)} all time`),
      tile('In wallets', num(d.tickets.inCirculation), 'Unspent, across every member'),
      tile('Staff', num(d.users.admins), 'Can open this office'),
    ].join('');

    const chartCard = (id: string, title: string, sub: string, table: string) =>
      `<div class="card"><h3>${title}</h3><p class="sub">${sub}</p><div class="chart" id="${id}"></div>${table}</div>`;
    const dailyTable = `<details><summary class="muted">Show as a table</summary><div class="table-wrap"><table><thead><tr><th>Day (UTC)</th><th class="r">Rounds</th><th class="r">Players</th><th class="r">New members</th><th class="r">Packs</th><th class="r">Tickets spent</th></tr></thead><tbody>${d.daily
      .slice()
      .reverse()
      .map((r) => `<tr><td>${esc(dayLabel(r.date))}</td><td class="r">${num(r.rounds)}</td><td class="r">${num(r.players)}</td><td class="r">${num(r.signups)}</td><td class="r">${num(r.purchases)}</td><td class="r">${num(r.ticketsSpent)}</td></tr>`)
      .join('')}</tbody></table></div></details>`;

    this.el.innerHTML = `${this.headHtml(d)}
      ${notices.length ? `<div class="notice">${notices.map((n) => `<p>${n}</p>`).join('')}</div>` : ''}
      <div class="tiles">${tiles}</div>
      <div class="grid grid-2">
        ${chartCard('c-rounds', 'Rounds per day', 'Every paid round, finished or not.', dailyTable)}
        ${chartCard('c-players', 'Players per day', 'Members who played at least one round.', '')}
        ${chartCard('c-signups', 'New members per day', 'Accounts created.', '')}
        ${chartCard('c-hours', 'When people play', `Rounds started by hour of the day (UTC), last ${d.days} days.`, '')}
      </div>
      <div class="card"><h3>Attractions</h3><p class="sub">Rounds in the last ${d.days} days, and how each attraction does over all time.</p>${this.ridesTable(d)}</div>
      <div class="grid grid-2">
        <div class="card"><h3>Top players</h3><p class="sub">Most rounds in the last ${d.days} days.</p>${this.playersTable(d)}</div>
        <div class="card"><h3>Park records</h3><p class="sub">The best ever reported, per attraction (client-measured, so for fun).</p>${this.recordsTable(d)}</div>
      </div>`;

    const dayTicks = d.daily.map((r) => dayLabel(r.date));
    renderBarChart(this.el.querySelector('#c-rounds')!, {
      label: 'Rounds per day',
      values: d.daily.map((r) => r.rounds),
      ticks: dayTicks,
      tips: d.daily.map((r) => `${dayLabel(r.date)}\n${plural(r.rounds, 'round', 'rounds')} · ${plural(r.ticketsSpent, 'ticket', 'tickets')} spent`),
    });
    renderBarChart(this.el.querySelector('#c-players')!, {
      label: 'Players per day',
      values: d.daily.map((r) => r.players),
      ticks: dayTicks,
      tips: d.daily.map((r) => `${dayLabel(r.date)}\n${plural(r.players, 'player', 'players')}`),
    });
    renderBarChart(this.el.querySelector('#c-signups')!, {
      label: 'New members per day',
      values: d.daily.map((r) => r.signups),
      ticks: dayTicks,
      tips: d.daily.map((r) => `${dayLabel(r.date)}\n${plural(r.signups, 'new member', 'new members')}`),
    });
    renderBarChart(this.el.querySelector('#c-hours')!, {
      label: 'Rounds by hour of the day, UTC',
      values: d.hours,
      ticks: d.hours.map((_, h) => `${String(h).padStart(2, '0')}h`),
      tips: d.hours.map((n, h) => `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 UTC\n${plural(n, 'round', 'rounds')}`),
    });
  }

  private ridesTable(d: Overview) {
    const shown = rides(d);
    const most = Math.max(1, ...shown.map((id) => d.byRide[id].roundsInRange));
    const rows = shown
      .sort((a, b) => d.byRide[b].roundsInRange - d.byRide[a].roundsInRange || d.byRide[b].rounds - d.byRide[a].rounds)
      .map((id) => {
        const r = d.byRide[id];
        const status = r.open ? '<span class="pill pill-good">Running</span>' : '<span class="pill pill-bad">Maintenance</span>';
        const meter = `<div class="meter"><span class="meter-track"><span class="meter-fill" style="width:${(r.roundsInRange / most) * 100}%"></span></span><span class="num">${num(r.roundsInRange)}</span></div>`;
        return `<tr><td><span class="cell-main">${esc(rideLabel(id))}</span></td><td>${status}</td><td class="r">${num(r.price)} 🎟️</td><td>${meter}</td><td class="r">${num(r.rounds)}</td><td class="r">${pct(r.completed, r.completed + r.abandoned)}</td><td class="r">${num(r.players)}</td><td class="r">${duration(r.avgSeconds)}</td><td class="r">${num(r.ticketsSpentInRange)}</td></tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table><thead><tr><th>Attraction</th><th>Status</th><th class="r">Price</th><th>Rounds (${d.days} d)</th><th class="r">All time</th><th class="r">Finished</th><th class="r">Players</th><th class="r">Avg round</th><th class="r">Tickets (${d.days} d)</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  private playersTable(d: Overview) {
    if (!d.topPlayers.length) return `<p class="empty">Nobody has played in the last ${d.days} days.</p>`;
    const rows = d.topPlayers
      .map(
        (p, i) =>
          `<tr><td class="r">${i + 1}</td><td><a href="#members/${encodeURIComponent(p.id)}" class="cell-main">${esc(p.username)}</a></td><td class="r">${num(p.rounds)}</td><td class="r">${num(p.ticketsSpent)}</td><td>${p.favourite ? esc(rideLabel(p.favourite)) : '—'}</td></tr>`,
      )
      .join('');
    return `<div class="table-wrap"><table><thead><tr><th class="r">#</th><th>Member</th><th class="r">Rounds</th><th class="r">Tickets</th><th>Favourite</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  private recordsTable(d: Overview) {
    const rows: string[] = [];
    for (const id of ATTRACTION_IDS) {
      const records = d.records[id];
      if (!records) continue;
      for (const [key, rec] of Object.entries(records)) {
        const dir = betterOf(key, id);
        if (dir === 'none') continue;
        const best = rec[dir];
        if (!best) continue;
        rows.push(
          `<tr><td>${esc(rideLabel(id))}</td><td>${esc(statLabel(key))}</td><td class="r"><strong>${esc(formatStat(key, best.value))}</strong></td><td>${esc(best.username)}<span class="cell-sub">${esc(when(best.at))}</span></td></tr>`,
        );
      }
    }
    if (!rows.length) return '<p class="empty">No records yet: they appear once rounds are finished.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Attraction</th><th>Record</th><th class="r">Best</th><th>Held by</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
}

/** The attractions worth a row: Creators' Valley's plots once ridden (an empty one is just ground). */
const rides = (d: Overview) => ATTRACTION_IDS.filter((id) => d.byRide[id] && (!isPlot(id) || d.byRide[id].rounds > 0));

function readDays(): OverviewDays {
  try {
    const v = Number(localStorage.getItem(DAYS_KEY));
    if ((OVERVIEW_DAYS as readonly number[]).includes(v)) return v as OverviewDays;
  } catch {
    // storage blocked: the default it is
  }
  return 30;
}
