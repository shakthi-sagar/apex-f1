"""FastF1 ingestion. The ONLY module that knows about FastF1 data structures.

Everything leaving this module is plain numpy arrays / dicts with times expressed
as float seconds of *session time* (FastF1's SessionTime), so the rest of the
pipeline is independent from FastF1/pandas conventions.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import timezone

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)


def _sec(v) -> float | None:
    if v is None or (isinstance(v, float) and np.isnan(v)) or pd.isna(v):
        return None
    if isinstance(v, pd.Timedelta):
        return v.total_seconds()
    return float(v)


def _tds(series: pd.Series) -> np.ndarray:
    return series.dt.total_seconds().to_numpy(dtype=np.float64)


@dataclass
class RawDriver:
    number: str
    code: str
    first_name: str
    last_name: str
    team: str
    team_color: str
    headshot_url: str | None
    grid: int | None
    position: int | None
    classified: str
    status: str
    points: float
    # position samples
    pos_t: np.ndarray
    pos_xyz: np.ndarray  # (n,3) FastF1 units (1/10 m)
    pos_ok: np.ndarray  # bool: OnTrack and not the (0,0,0) placeholder
    # car samples
    car_t: np.ndarray
    speed: np.ndarray  # km/h
    rpm: np.ndarray
    gear: np.ndarray
    throttle: np.ndarray  # 0..100 (104 = sensor glitch in source)
    brake: np.ndarray  # bool
    drs: np.ndarray  # raw FastF1 DRS code


@dataclass
class RawRace:
    season: int
    round: int
    session: str
    event_name: str
    official_name: str
    location: str
    country: str
    country_code: str
    circuit_key: int
    circuit_short: str
    circuit_ref: str  # ergast id, e.g. "interlagos"
    circuit_name: str
    lat: float
    lon: float
    date_utc: str  # session t0 (ISO)
    t0_utc: pd.Timestamp
    gmt_offset_h: float
    scheduled_start_local: str | None
    total_laps: int
    drivers: dict[str, RawDriver]
    laps: list[dict]
    track_status: list[dict]
    session_status: list[dict]
    weather: list[dict]
    race_control: list[dict]
    corners: list[dict]
    marshal_sectors: list[dict]
    circuit_rotation: float
    extra: dict = field(default_factory=dict)


def enable_cache(path: str | None = None) -> None:
    import fastf1

    path = path or os.environ.get("FASTF1_CACHE", os.path.expanduser("~/.cache/f1sim/fastf1"))
    os.makedirs(path, exist_ok=True)
    fastf1.Cache.enable_cache(path)
    logging.getLogger("fastf1").setLevel(logging.WARNING)


def load_race(season: int, rnd: int, session: str = "R") -> RawRace:
    import fastf1
    from fastf1.ergast import Ergast

    s = fastf1.get_session(season, rnd, session)
    s.load(laps=True, telemetry=True, weather=True, messages=True)

    info = s.session_info
    meeting = info.get("Meeting", {})
    try:
        circ = Ergast().get_circuits(season=season, round=rnd).iloc[0]
        lat, lon = float(circ["lat"]), float(circ["long"])
        circuit_ref, circuit_name = str(circ["circuitId"]), str(circ["circuitName"])
    except Exception as e:  # pragma: no cover - network
        log.warning("ergast circuit lookup failed: %s", e)
        lat = lon = float("nan")
        circuit_ref = meeting.get("Circuit", {}).get("ShortName", "unknown").lower().replace(" ", "_")
        circuit_name = meeting.get("Circuit", {}).get("ShortName", "Unknown")

    t0 = pd.Timestamp(s.t0_date).tz_localize(timezone.utc) if s.t0_date.tzinfo is None else pd.Timestamp(s.t0_date)

    drivers: dict[str, RawDriver] = {}
    res = s.results
    for num in s.drivers:
        r = res.loc[num] if num in res.index else None
        pos = s.pos_data.get(num)
        car = s.car_data.get(num)
        if pos is None or car is None or len(pos) == 0 or len(car) == 0:
            log.warning("driver %s has no telemetry; skipped", num)
            continue
        pxyz = pos[["X", "Y", "Z"]].to_numpy(dtype=np.float64)
        pos_ok = (pos["Status"].to_numpy() == "OnTrack") & ~np.all(pxyz == 0, axis=1)

        def rget(k, default=None):
            if r is None:
                return default
            v = r.get(k, default)
            return default if pd.isna(v) else v

        drivers[num] = RawDriver(
            number=str(num),
            code=str(rget("Abbreviation", num)),
            first_name=str(rget("FirstName", "")),
            last_name=str(rget("LastName", "")),
            team=str(rget("TeamName", "")),
            team_color="#" + str(rget("TeamColor", "888888") or "888888"),
            headshot_url=rget("HeadshotUrl"),
            grid=int(rget("GridPosition")) if rget("GridPosition") else None,
            position=int(rget("Position")) if rget("Position") else None,
            classified=str(rget("ClassifiedPosition", "")),
            status=str(rget("Status", "")),
            points=float(rget("Points", 0) or 0),
            pos_t=_tds(pos["SessionTime"]),
            pos_xyz=pxyz,
            pos_ok=pos_ok,
            car_t=_tds(car["SessionTime"]),
            speed=car["Speed"].to_numpy(dtype=np.float64),
            rpm=car["RPM"].to_numpy(dtype=np.float64),
            gear=car["nGear"].to_numpy(dtype=np.float64),
            throttle=car["Throttle"].to_numpy(dtype=np.float64),
            brake=car["Brake"].to_numpy().astype(bool),
            drs=car["DRS"].to_numpy(dtype=np.float64),
        )

    laps = []
    for _, L in s.laps.iterrows():
        laps.append(
            {
                "driver": str(L["DriverNumber"]),
                "lap": int(L["LapNumber"]),
                "time": _sec(L["LapTime"]),
                "start": _sec(L["LapStartTime"]),
                "end": _sec(L["Time"]),
                "s1": _sec(L["Sector1Time"]),
                "s2": _sec(L["Sector2Time"]),
                "s3": _sec(L["Sector3Time"]),
                "s1_end": _sec(L["Sector1SessionTime"]),
                "s2_end": _sec(L["Sector2SessionTime"]),
                "pit_in": _sec(L["PitInTime"]),
                "pit_out": _sec(L["PitOutTime"]),
                "stint": int(L["Stint"]) if not pd.isna(L["Stint"]) else None,
                "compound": None if pd.isna(L["Compound"]) else str(L["Compound"]),
                "tyre_life": None if pd.isna(L["TyreLife"]) else int(L["TyreLife"]),
                "fresh": None if pd.isna(L["FreshTyre"]) else bool(L["FreshTyre"]),
                "position": None if pd.isna(L["Position"]) else int(L["Position"]),
                "track_status": None if pd.isna(L["TrackStatus"]) else str(L["TrackStatus"]),
                "deleted": bool(L["Deleted"]) if not pd.isna(L["Deleted"]) else False,
                "personal_best": bool(L["IsPersonalBest"]) if not pd.isna(L["IsPersonalBest"]) else False,
                "speed_trap": _sec(L["SpeedST"]),
            }
        )

    ts = [{"t": _sec(r["Time"]), "status": str(r["Status"]), "message": str(r["Message"])} for _, r in s.track_status.iterrows()]
    ss = [{"t": _sec(r["Time"]), "status": str(r["Status"])} for _, r in s.session_status.iterrows()]
    wx = [
        {
            "t": _sec(r["Time"]),
            "air": float(r["AirTemp"]),
            "track": float(r["TrackTemp"]),
            "humidity": float(r["Humidity"]),
            "pressure": float(r["Pressure"]),
            "rain": bool(r["Rainfall"]),
            "wind_dir": float(r["WindDirection"]),
            "wind_speed": float(r["WindSpeed"]),
        }
        for _, r in s.weather_data.iterrows()
    ]
    rc = []
    for _, r in s.race_control_messages.iterrows():
        t = pd.Timestamp(r["Time"])
        t = t.tz_localize(timezone.utc) if t.tzinfo is None else t
        rc.append(
            {
                "t": (t - t0).total_seconds(),
                "category": str(r.get("Category") or ""),
                "message": str(r.get("Message") or ""),
                "flag": None if pd.isna(r.get("Flag")) else str(r.get("Flag")),
                "scope": None if pd.isna(r.get("Scope")) else str(r.get("Scope")),
                "sector": None if pd.isna(r.get("Sector")) else int(r.get("Sector")),
                "driver": None if pd.isna(r.get("RacingNumber")) else str(r.get("RacingNumber")),
                "lap": None if pd.isna(r.get("Lap")) else int(r.get("Lap")),
            }
        )

    try:
        ci = s.get_circuit_info()
        corners = [
            {"number": int(c["Number"]), "letter": str(c["Letter"] or ""), "x": float(c["X"]), "y": float(c["Y"]),
             "angle": float(c["Angle"]), "distance": float(c["Distance"])}
            for _, c in ci.corners.iterrows()
        ]
        msec = [
            {"number": int(c["Number"]), "x": float(c["X"]), "y": float(c["Y"]), "distance": float(c["Distance"])}
            for _, c in ci.marshal_sectors.iterrows()
        ]
        rotation = float(ci.rotation)
    except Exception as e:
        log.warning("circuit info unavailable: %s", e)
        corners, msec, rotation = [], [], 0.0

    gmt = info.get("GmtOffset")
    gmt_h = gmt.total_seconds() / 3600 if gmt is not None else 0.0
    start = info.get("StartDate")

    return RawRace(
        season=season,
        round=rnd,
        session=session,
        event_name=str(s.event["EventName"]),
        official_name=str(meeting.get("OfficialName") or s.event.get("OfficialEventName") or s.event["EventName"]),
        location=str(s.event["Location"]),
        country=str(s.event["Country"]),
        country_code=str(meeting.get("Country", {}).get("Code", "")),
        circuit_key=int(meeting.get("Circuit", {}).get("Key", 0)),
        circuit_short=str(meeting.get("Circuit", {}).get("ShortName", "")),
        circuit_ref=circuit_ref,
        circuit_name=circuit_name,
        lat=lat,
        lon=lon,
        date_utc=t0.isoformat(),
        t0_utc=t0,
        gmt_offset_h=gmt_h,
        scheduled_start_local=start.isoformat() if start is not None else None,
        total_laps=int(s.total_laps or max(l["lap"] for l in laps)),
        drivers=drivers,
        laps=laps,
        track_status=ts,
        session_status=ss,
        weather=wx,
        race_control=rc,
        corners=corners,
        marshal_sectors=msec,
        circuit_rotation=rotation,
    )
