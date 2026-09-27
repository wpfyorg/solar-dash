(function () {
  'use strict';

  const LAT = 21.1292;
  const LON = 86.732285;
  const TILT_DEG = 23;
  const PANEL_COUNT = 5;
  const PANEL_W = 585;
  const PANEL_KWP = PANEL_COUNT * PANEL_W / 1000;
  const INVERTER_W = 3500;
  const PRICE_PER_KWH = 4.5;
  const INSTALL_DATE = '2025-10-18';
  const IST_OFFSET_MIN = 330;
  const IST_STANDARD_MERIDIAN = 82.5;
  const DEG = Math.PI / 180;
  const dayCache = new Map();
  const monthCache = new Map();

  const qs = new URLSearchParams(location.search);
  const forcedWeather = ['clear', 'cloudy', 'rain', 'storm'].includes(qs.get('weather')) ? qs.get('weather') : null;
  const forcedTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(qs.get('time') || '') ? qs.get('time') : null;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function hm(minute) {
    const m = Math.round(minute);
    return `${pad2(Math.floor(m / 60) % 24)}:${pad2((m % 60 + 60) % 60)}`;
  }
  function isoDateFromUtcDate(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
  function dateParts(iso) { return iso.split('-').map(Number); }
  function dayOfYear(y, m, d) { return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000); }
  function shiftDate(iso, amount) {
    const [y, m, d] = dateParts(iso);
    return isoDateFromUtcDate(new Date(Date.UTC(y, m - 1, d + amount)));
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function seeded(seed) {
    let x = seed >>> 0;
    return function () {
      x += 0x6D2B79F5;
      let t = x;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function round(v, digits = 0) { const p = 10 ** digits; return Math.round(v * p) / p; }

  function nowUtc() {
    if (!forcedTime) return new Date();
    const [date, time] = forcedTime.split('T');
    const [y, m, d] = dateParts(date);
    const [hh, mm] = time.split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, d, hh, mm - IST_OFFSET_MIN));
  }
  function nowIstParts() {
    const shifted = new Date(nowUtc().getTime() + IST_OFFSET_MIN * 60000);
    return {
      date: isoDateFromUtcDate(shifted), y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
      minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
  }

  function solarDay(iso) {
    const [y, m, d] = dateParts(iso);
    const n = dayOfYear(y, m, d);
    const decl = 23.45 * DEG * Math.sin((360 * (284 + n) / 365) * DEG);
    const phi = LAT * DEG;
    const tilt = TILT_DEG * DEG;
    const b = (360 / 365 * (n - 81)) * DEG;
    const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
    const solarNoon = 720 - 4 * (LON - IST_STANDARD_MERIDIAN) - eot;
    const cosH0 = clamp(-Math.tan(phi) * Math.tan(decl), -1, 1);
    const h0 = Math.acos(cosH0) / DEG;
    return { decl, phi, tilt, solarNoon, sunrise: solarNoon - h0 * 4, sunset: solarNoon + h0 * 4, n };
  }

  function clearPower(iso, minute) {
    const s = solarDay(iso);
    const hourAngle = ((minute - s.solarNoon) / 4) * DEG;
    const sinElev = Math.sin(s.phi) * Math.sin(s.decl) + Math.cos(s.phi) * Math.cos(s.decl) * Math.cos(hourAngle);
    if (sinElev <= 0) return 0;
    const cosInc = Math.sin(s.decl) * Math.sin(s.phi - s.tilt) + Math.cos(s.decl) * Math.cos(s.phi - s.tilt) * Math.cos(hourAngle);
    const airMassPenalty = 0.82 + 0.18 * Math.sqrt(clamp(sinElev, 0, 1));
    const tempPenalty = 0.94 - 0.055 * Math.pow(clamp((minute - s.solarNoon) / 360, -1, 1), 2);
    const poa = Math.pow(clamp(cosInc, 0, 1), 1.08);
    return clamp(PANEL_KWP * 1000 * 0.91 * poa * airMassPenalty * tempPenalty, 0, INVERTER_W);
  }

  function weatherRegime(iso) {
    const [, m] = dateParts(iso);
    const r = seeded(hashString(`regime:${iso}`));
    const x = r();
    if (forcedWeather) return forcedWeather;
    if (m >= 6 && m <= 9) return x < 0.28 ? 'rain' : x < 0.40 ? 'storm' : x < 0.78 ? 'cloudy' : 'clear';
    if (m === 10 || m === 11) return x < 0.18 ? 'rain' : x < 0.48 ? 'cloudy' : 'clear';
    if (m >= 3 && m <= 5) return x < 0.14 ? 'storm' : x < 0.38 ? 'cloudy' : 'clear';
    return x < 0.16 ? 'cloudy' : 'clear';
  }

  function weatherForHour(iso, hour) {
    const regime = weatherRegime(iso);
    const r = seeded(hashString(`${iso}:wx:${hour}`));
    const wobble = 12 * Math.sin((hour - 7) * 0.8) + (r() - 0.5) * 20;
    let cloud = 12, code = 0, rain = 0;
    if (regime === 'clear') { cloud = clamp(10 + wobble, 2, 34); code = cloud > 22 ? 1 : 0; }
    if (regime === 'cloudy') { cloud = clamp(55 + wobble, 32, 84); code = cloud > 76 ? 3 : 2; }
    if (regime === 'rain') {
      const wet = hour >= 9 && hour <= 19 && (r() > 0.35 || hour === 15 || hour === 16);
      cloud = clamp(72 + wobble, 52, 98); rain = wet ? 0.3 + r() * 3.2 : 0; code = wet ? (rain > 1.6 ? 63 : 61) : 3;
    }
    if (regime === 'storm') {
      const wet = hour >= 11 && hour <= 19 && (r() > 0.25 || hour === 16);
      cloud = clamp(82 + wobble, 62, 100); rain = wet ? 0.8 + r() * 5.5 : 0; code = wet && rain > 2.3 ? 95 : wet ? 80 : 3;
    }
    const [, m] = dateParts(iso);
    const seasonal = 28 + 4 * Math.sin(((m - 3) / 12) * Math.PI * 2);
    const temp = seasonal + 4.5 * Math.sin(((hour - 9) / 24) * Math.PI * 2) + (r() - 0.5) * 1.2;
    return { cloud: round(cloud), code, rain: round(rain, 1), temp: round(temp, 1) };
  }

  function transmittance(wx, iso, minute) {
    const r = seeded(hashString(`${iso}:power:${Math.floor(minute / 5)}`));
    const cloudLoss = 1 - 0.76 * Math.pow(wx.cloud / 100, 1.25);
    const rainLoss = wx.rain > 0 ? clamp(0.76 - wx.rain * 0.055, 0.42, 0.76) : 1;
    const edge = 0.92 + r() * 0.15;
    const cloudEdge = wx.cloud > 40 ? 0.82 + r() * 0.28 : 1;
    return clamp(cloudLoss * rainLoss * edge * cloudEdge, 0.12, 1.04);
  }

  function powerCut(iso) {
    const s = solarDay(iso);
    const r = seeded(hashString(`cut:${iso}`));
    const earliest = Math.max(s.sunrise + 75, 8 * 60 + 30);
    const latest = Math.min(s.sunset - 90, 16 * 60);
    const duration = 20 + Math.floor(r() * 36);
    const start = Math.round((earliest + r() * Math.max(30, latest - earliest - duration)) / 5) * 5;
    return { start, end: Math.min(start + duration, s.sunset - 30) };
  }

  function inPowerCut(iso, minute) {
    const cut = powerCut(iso);
    return minute >= cut.start && minute < cut.end;
  }

  function actualPower(iso, minute, liveJitter = false) {
    const clear = clearPower(iso, minute);
    if (!clear) return 0;
    if (inPowerCut(iso, minute)) return 0;
    const wx = weatherForHour(iso, Math.floor(minute / 60));
    let w = clear * transmittance(wx, iso, minute);
    if (liveJitter) w *= 0.965 + Math.random() * 0.07;
    return round(clamp(w, 0, INVERTER_W));
  }

  function expectedPower(iso, minute) {
    const clear = clearPower(iso, minute);
    const wx = weatherForHour(iso, Math.floor(minute / 60));
    const cloudLoss = 1 - 0.72 * Math.pow(wx.cloud / 100, 1.2);
    const rainLoss = wx.rain > 0 ? 0.68 : 1;
    return round(clamp(clear * cloudLoss * rainLoss, 0, INVERTER_W));
  }

  function integrate(points, stepMin) {
    if (!points.length) return 0;
    return points.reduce((sum, p) => sum + p.solar_w * stepMin / 60, 0);
  }

  function dailyWeather(iso) {
    const hours = Array.from({ length: 24 }, (_, h) => weatherForHour(iso, h));
    const clouds = hours.slice(6, 19).map(x => x.cloud);
    const temps = hours.map(x => x.temp);
    const precip = hours.reduce((sum, x) => sum + x.rain, 0);
    const code = hours.reduce((worst, x) => Math.max(worst, x.code), 0);
    return {
      code, cloud_pct: round(clouds.reduce((a, b) => a + b, 0) / clouds.length), precip_mm: round(precip, 1),
      temp_min: round(Math.min(...temps), 1), temp_max: round(Math.max(...temps), 1),
    };
  }

  function dayRecord(iso, cutoffMinute = 1440) {
    const cacheKey = cutoffMinute >= 1440 ? iso : `${iso}:${Math.floor(cutoffMinute / 5) * 5}`;
    if (dayCache.has(cacheKey)) return dayCache.get(cacheKey);
    const s = solarDay(iso);
    const start = Math.max(0, Math.floor((s.sunrise - 30) / 5) * 5);
    const stop = Math.min(1435, Math.ceil((Math.min(cutoffMinute, s.sunset + 30)) / 5) * 5);
    const series = [];
    for (let minute = start; minute <= stop; minute += 5) series.push({ t: hm(minute), solar_w: actualPower(iso, minute) });
    const produced = integrate(series, 5);
    let peak = { t: '', solar_w: 0 };
    for (const p of series) if (p.solar_w > peak.solar_w) peak = p;
    const cut = powerCut(iso);
    const cutVisible = cutoffMinute >= cut.start;
    const cutEnd = Math.min(cut.end, cutoffMinute);
    let lostWh = 0;
    if (cutVisible) {
      for (let minute = cut.start; minute < cutEnd; minute += 5) lostWh += expectedPower(iso, minute) * 5 / 60;
    }
    const events = cutVisible ? [{
      id: `demo-cut-${iso}`,
      date: iso,
      kind: 'power_cut',
      from: hm(cut.start),
      to: cutoffMinute < cut.end ? null : hm(cut.end),
      ongoing: cutoffMinute < cut.end,
      lost_wh: round(lostWh),
      detail: null,
    }] : [];
    const record = {
      date: iso, series, produced_wh: round(produced), peak_w: peak.solar_w, peak_at: peak.t,
      sunrise: hm(s.sunrise), sunset: hm(s.sunset), weather: dailyWeather(iso), events,
    };
    dayCache.set(cacheKey, record);
    return record;
  }

  function forecastDay(iso, includeSeries) {
    const s = solarDay(iso);
    const series = [];
    let expectedWh = 0, clearWh = 0;
    for (let minute = 0; minute < 1440; minute += 15) {
      const expected = expectedPower(iso, minute);
      const clear = round(clearPower(iso, minute));
      expectedWh += expected * 0.25;
      clearWh += clear * 0.25;
      if (includeSeries && (minute >= s.sunrise - 30 && minute <= s.sunset + 30)) series.push({ t: hm(minute), expected_w: expected, clear_w: clear });
    }
    const weather = dailyWeather(iso);
    const sky = includeSeries ? Array.from({ length: 24 }, (_, h) => {
      const w = weatherForHour(iso, h);
      return { t: `${pad2(h)}:30`, code: w.code, cloud: w.cloud, temp: w.temp };
    }) : [];
    return {
      date: iso, expected_wh: round(expectedWh), clear_wh: round(clearWh), weather_code: weather.code,
      cloud_pct: weather.cloud_pct, temp_min: weather.temp_min, temp_max: weather.temp_max,
      precip_mm: weather.precip_mm, series, sky,
    };
  }

  function monthData(y, m, todayInfo) {
    const isCurrent = y === todayInfo.y && m === todayInfo.m;
    const liveSlot = isCurrent ? `:${Math.floor(todayInfo.minute / 5) * 5}` : '';
    const key = `${y}-${pad2(m)}:${todayInfo.date}${liveSlot}`;
    if (monthCache.has(key)) return monthCache.get(key);
    const count = daysInMonth(y, m);
    const days = [];
    let totalWh = 0;
    let best = null;
    for (let d = 1; d <= count; d++) {
      const iso = `${y}-${pad2(m)}-${pad2(d)}`;
      const notInstalled = iso < INSTALL_DATE;
      const future = iso > todayInfo.date;
      let produced = null;
      if (!notInstalled && !future) {
        produced = iso === todayInfo.date ? dayRecord(iso, todayInfo.minute).produced_wh : dayRecord(iso).produced_wh;
        totalWh += produced;
        if (!best || produced > best.produced_wh) best = { day: d, produced_wh: produced };
      }
      days.push({ day: d, produced_wh: produced, not_installed: notInstalled });
    }
    const value = { month: m, year: y, days, total_wh: round(totalWh), best_day: best };
    monthCache.set(key, value);
    return value;
  }

  function yearData(y, todayInfo) {
    const months = [];
    let lifetime = 0;
    const installYear = Number(INSTALL_DATE.slice(0, 4));
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}-${pad2(m)}`;
      const installYm = INSTALL_DATE.slice(0, 7);
      const future = y > todayInfo.y || (y === todayInfo.y && m > todayInfo.m);
      const notInstalled = ym < installYm;
      let produced = null;
      if (!future && !notInstalled) produced = monthData(y, m, todayInfo).total_wh;
      months.push({ month: m, produced_wh: produced, not_installed: notInstalled });
    }
    for (let yy = installYear; yy <= todayInfo.y; yy++) {
      const startM = yy === installYear ? Number(INSTALL_DATE.slice(5, 7)) : 1;
      const endM = yy === todayInfo.y ? todayInfo.m : 12;
      for (let m = startM; m <= endM; m++) lifetime += monthData(yy, m, todayInfo).total_wh;
    }
    return { year: y, months, since_install_wh: round(lifetime) };
  }

  function stateData() {
    const info = nowIstParts();
    const today = dayRecord(info.date, info.minute);
    const yesterdayIso = shiftDate(info.date, -1);
    const yesterday = dayRecord(yesterdayIso);
    const livePower = actualPower(info.date, info.minute, true);
    const yesterdayComparable = dayRecord(yesterdayIso, info.minute).produced_wh;
    const currentMonth = monthData(info.y, info.m, info);
    const year = yearData(info.y, info);
    const fToday = forecastDay(info.date, true);
    const fTomorrow = forecastDay(shiftDate(info.date, 1), false);
    const utcNow = nowUtc().toISOString();
    const events = [];
    for (let offset = 0; offset < 14; offset++) {
      const iso = shiftDate(info.date, -offset);
      const record = dayRecord(iso, offset === 0 ? info.minute : 1440);
      events.push(...record.events);
    }
    return {
      status: 'ok', server_now: utcNow, has_meter: false,
      plant: {
        name: 'Solar · Demo', capacity_w: INVERTER_W, price_per_kwh: PRICE_PER_KWH,
        panel_kwp: PANEL_KWP, install_date: INSTALL_DATE, panel_count: PANEL_COUNT, panel_w: PANEL_W,
      },
      live: { solar_w: livePower, home_w: null, export_w: null, import_w: null, updated_at: new Date().toISOString() },
      sun: { sunrise: today.sunrise, sunset: today.sunset },
      today: {
        series: today.series, produced_wh: today.produced_wh, earned: today.produced_wh / 1000 * PRICE_PER_KWH,
        peak_w: today.peak_w, peak_at: today.peak_at, vs_yesterday_wh: round(today.produced_wh - yesterdayComparable),
        home_wh: null, exported_wh: null, imported_wh: null,
      },
      yesterday: { series: yesterday.series, produced_wh: yesterday.produced_wh },
      month: currentMonth, year,
      devices: [{ sn: 'DEMO-35K-001', device_type: 'H1-3.6-E', status: 1, power_w: livePower }],
      alarms: [],
      forecast: { source: 'mock', fetched_at: utcNow, pr: 0.88, pr_days: 14, today: fToday, tomorrow: fTomorrow },
      events,
    };
  }

  function jsonResponse(data) {
    return Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }));
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const raw = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    const url = new URL(raw, location.href);
    if (url.pathname.endsWith('/api/state') || url.pathname === '/api/state') return jsonResponse(stateData());
    if (url.pathname.endsWith('/api/month') || url.pathname === '/api/month') {
      const ym = url.searchParams.get('ym') || '';
      const match = /^(\d{4})-(\d{2})$/.exec(ym);
      if (!match) return Promise.resolve(new Response('{}', { status: 400 }));
      const info = nowIstParts();
      return jsonResponse(monthData(Number(match[1]), Number(match[2]), info));
    }
    if (url.pathname.endsWith('/api/day') || url.pathname === '/api/day') {
      const iso = url.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return Promise.resolve(new Response('{}', { status: 400 }));
      const info = nowIstParts();
      return jsonResponse(dayRecord(iso, iso === info.date ? info.minute : 1440));
    }
    return originalFetch(input, init);
  };

})();
