"""Generates golden protocol vectors from the Python reference implementation.

Usage (from a venv with coolth installed):
    pip install pycryptodome httpx git+https://github.com/a904guy/coolth-ac-controller.git
    python test/fixtures/generate_golden.py > test/fixtures/golden.json

The vectors pin the JavaScript port byte-for-byte to the reference code. They
cover only offline crypto and frame logic; they say nothing about the live
Midea Cloud.
"""
import json

from Crypto.Cipher import AES
from Crypto.Util import Padding

from coolth.cloud import SmartHomeCloud
from coolth.device.AC.command import (Command, GetCapabilitiesCommand,
                                      GetStateCommand, Response,
                                      SetStateCommand)

sec = SmartHomeCloud._Security()
out = {}

out["crypto"] = {
    "password": "Example-Only!123",
    "loginId": "fixture-login-id",
    "sha": sec.encrypt_password("fixture-login-id", "Example-Only!123"),
    "iam": sec.encrypt_iam_password("fixture-login-id", "Example-Only!123"),
    "signBody": '{"fixture":true}',
    "signRandom": "1234567890",
    "sign": sec.sign('{"fixture":true}', "1234567890"),
    "aesKey": "0123456789abcdef",
    "aesIv": "fedcba9876543210",
    "aesPlain": "-86,35,-84,0,37",
    "aesCipherHex": AES.new(
        b"0123456789abcdef", AES.MODE_CBC, iv=b"fedcba9876543210").encrypt(
            Padding.pad(b"-86,35,-84,0,37", 16)).hex(),
}


def frame_with_id(cmd, msg_id):
    Command._message_id = msg_id - 1
    return cmd.tobytes().hex()


out["query"] = {
    "state": frame_with_id(GetStateCommand(), 1),
    "capabilities": frame_with_id(GetCapabilitiesCommand(), 2),
    "capabilitiesAdditional": frame_with_id(GetCapabilitiesCommand(True), 3),
}

base = dict(beep_on=False, power_on=True, target_temperature=22.0,
            operational_mode=2, fan_speed=102, eco=False, swing_mode=0,
            turbo=False, fahrenheit=False, sleep=False, freeze_protection=False,
            follow_me=False, purifier=False, target_humidity=40,
            aux_heat=False, force_aux_heat=False, independent_aux_heat=False)

set_cases = {
    "cool22_auto_on": {},
    "off": {"power_on": False},
    "heat24_5": {"operational_mode": 4, "target_temperature": 24.5},
    "dry": {"operational_mode": 3, "target_temperature": 25.0},
    "fan_only": {"operational_mode": 5},
    "auto": {"operational_mode": 1, "target_temperature": 26.0},
    "temp16": {"target_temperature": 16.0},
    "temp17": {"target_temperature": 17.0},
    "temp30": {"target_temperature": 30.0},
    "temp31": {"target_temperature": 31.0},
    "fan40": {"fan_speed": 40},
    "fan100": {"fan_speed": 100},
    "fan37_custom": {"fan_speed": 37},
    "swing_both": {"swing_mode": 0xF},
    "keeps_flags": {"eco": True, "turbo": True, "sleep": True, "fahrenheit": True,
                    "freeze_protection": True, "purifier": True,
                    "follow_me": True, "target_humidity": 55, "aux_heat": True},
}
out["set"] = []
for i, (name, over) in enumerate(set_cases.items(), start=10):
    params = {**base, **over}
    cmd = SetStateCommand()
    for k, v in params.items():
        setattr(cmd, k, v)
    out["set"].append({"name": name, "messageId": i, "params": params,
                       "frame": frame_with_id(cmd, i)})

# Real-shape state response from the ac-man fixtures (cool, 21 C, auto fan).
state_frames = [
    "aa23ac00000000000303c00145660000003c0010045c6b20000000000000000000020d79",
]
out["state"] = []
for hx in state_frames:
    r = Response.construct(bytes.fromhex(hx))
    out["state"].append({"frame": hx, "parsed": {
        "power_on": r.power_on, "target_temperature": r.target_temperature,
        "operational_mode": r.operational_mode, "fan_speed": r.fan_speed,
        "swing_mode": r.swing_mode, "turbo": r.turbo, "eco": r.eco,
        "sleep": r.sleep, "fahrenheit": r.fahrenheit,
        "indoor_temperature": r.indoor_temperature,
        "outdoor_temperature": r.outdoor_temperature,
        "filter_alert": r.filter_alert, "display_on": r.display_on,
        "error_code": r.error_code, "target_humidity": r.target_humidity,
        "freeze_protection": r.freeze_protection,
        "follow_me": r.follow_me, "purifier": r.purifier,
        "aux_heat": r.aux_heat,
        "independent_aux_heat": r.independent_aux_heat}})

cap_frames = [
    "aa29ac00000000000003b5051002010114020100150201011a020101250207203c203c203c0100018345",
]
out["capabilities"] = []
for hx in cap_frames:
    r = Response.construct(bytes.fromhex(hx))
    out["capabilities"].append({"frame": hx, "raw": r.raw_capabilities,
                                "additional": r.additional_capabilities})

print(json.dumps(out, indent=2, sort_keys=True))
