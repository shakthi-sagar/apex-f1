"""Atmosphere/environment description derived from time, place and weather data."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np


def solar_position(when_utc: datetime, lat: float, lon: float) -> tuple[float, float]:
    """(azimuth deg clockwise from north, elevation deg). NOAA simplified algorithm (~0.1° accuracy)."""
    jd = when_utc.timestamp() / 86400.0 + 2440587.5
    n = jd - 2451545.0
    L = (280.460 + 0.9856474 * n) % 360
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    lam = math.radians(L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    eps = math.radians(23.439 - 0.0000004 * n)
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24
    lst = math.radians((gmst * 15 + lon) % 360)
    ha = lst - ra
    phi = math.radians(lat)
    el = math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(ha))
    az = math.atan2(-math.sin(ha), math.tan(dec) * math.cos(phi) - math.sin(phi) * math.cos(ha))
    return (math.degrees(az) % 360, math.degrees(el))


def describe(raw, t_start: float, t_end: float, theme: dict) -> dict:
    t0 = raw.t0_utc.to_pydatetime()
    sun = []
    for t in np.linspace(t_start, t_end, 9):
        when = t0 + timedelta(seconds=float(t))
        az, el = solar_position(when.astimezone(timezone.utc), raw.lat, raw.lon)
        sun.append({"t": round(float(t), 1), "azimuth": round(az, 2), "elevation": round(el, 2)})
    wx = [w for w in raw.weather if t_start - 600 <= w["t"] <= t_end + 60] or raw.weather
    rain = np.array([w["rain"] for w in wx], float)
    hum = np.array([w["humidity"] for w in wx])
    rain_frac = float(rain.mean()) if len(rain) else 0.0
    night = bool(theme.get("night")) or min(s["elevation"] for s in sun) < -2
    # track wetness: rises quickly with rain, dries slowly (visual model, derived)
    wet = []
    level = 0.0
    prev_t = wx[0]["t"] if wx else 0
    for w in wx:
        dt = max(0.0, w["t"] - prev_t)
        prev_t = w["t"]
        level = min(1.0, level + dt / 300.0) if w["rain"] else max(0.0, level - dt / 1500.0)
        wet.append({"t": round(w["t"], 1), "rain": bool(w["rain"]), "wetness": round(level, 3),
                    "air": w["air"], "track": w["track"], "humidity": w["humidity"],
                    "windDir": w["wind_dir"], "windSpeed": w["wind_speed"]})
    # if it had rained before the window, start wet
    if raw.weather and any(w["rain"] for w in raw.weather if w["t"] < t_start):
        for e in wet:
            e["wetness"] = round(max(e["wetness"], 0.8 if e["t"] < t_start + 900 else e["wetness"]), 3)
    local = t0 + timedelta(seconds=t_start + 150, hours=raw.gmt_offset_h)
    return {
        "localStart": local.strftime("%H:%M"),
        "utcOffsetHours": raw.gmt_offset_h,
        "sun": sun,
        "night": night,
        "rainFraction": round(rain_frac, 3),
        "cloudCover": round(float(np.clip(0.35 + 0.65 * rain_frac + (hum.mean() - 60) / 120 if len(hum) else 0.4, 0.1, 1.0)), 3),
        "fog": round(float(np.clip((hum.mean() - 50) / 60 if len(hum) else 0.2, 0.05, 0.9)) * theme.get("haze", 0.4) * 2, 3),
        "weather": wet,
        "theme": theme,
        "derived": ["wetness", "cloudCover", "fog"],
    }
