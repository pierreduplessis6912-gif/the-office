#!/usr/bin/env python3
"""Decides what the production "trial" workflow may do. It WRITES NOTHING and calls nothing: it reads the inputs and two answers the workflow fetched, and prints a decision.

  action "apply"   the business exists, is active, and has a trial: the workflow may CONVERT it to a plan it pays for, or EXTEND its trial
  action "refuse"  anything else (exit status 2): the workflow stops before any write and goes red, with the reasons

Usage: trial-guard.py <inputs.json> <directory.json> <plans.json>
  inputs.json: business_id, op ("convert" or "extend"), plan (convert), days (extend; text, as a workflow input), confirm.
Never decides blind: inputs, a directory or a plan list that cannot be read is a refusal. Input checks come first. Only business ids, plan names and numbers are involved, no personal data.
"""
import datetime
import json
import re
import sys

ID_OK = re.compile(r"[a-z0-9][a-z0-9-]{1,38}[a-z0-9]")           # the server's own rule (directory.ts BUSINESS_ID_PATTERN)
OPS = ("convert", "extend")
MAX_DAYS = 90                                                      # worker/src/freetrial.ts MAX_EXTEND_DAYS


def parse_time(text):
    try:
        return datetime.datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    except Exception:  # noqa: BLE001
        return None


def decide(business_id, op, plan, days, confirm, directory_raw, plans_raw, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    business_id = (business_id or "").strip() if business_id is not None else ""
    confirm = confirm if confirm is not None else ""
    op = (op or "").strip() if op is not None else ""
    plan = (plan or "").strip() if plan is not None else ""
    days_text = (days or "").strip() if days is not None else ""
    out = {"action": "refuse", "business_id": business_id or None, "op": op or None, "plan": None, "days": None, "name": None, "members": None, "state": None, "trialEndsAt": None, "warnings": [], "reasons": []}
    why = out["reasons"]
    if not ID_OK.fullmatch(business_id):
        why.append("a business id is 3 to 40 lower-case letters, digits and hyphens, not starting or ending with a hyphen")
    if confirm != business_id:
        why.append("to do this, type the business id exactly in the confirm box")
    if op not in OPS:
        why.append('the action must be "convert" or "extend"')
    elif op == "convert":
        if not plan:
            why.append("name the plan to convert the business to")
        elif plan == "trial":
            why.append("the trial plan is not a plan to convert TO: choose the plan the business pays for")
        out["plan"] = plan or None
    else:
        if not re.fullmatch(r"[0-9]{1,3}", days_text) or not (1 <= int(days_text) <= MAX_DAYS):
            why.append(f"days is a whole number from 1 to {MAX_DAYS}")
        else:
            out["days"] = int(days_text)
    if why:
        return out
    try:
        directory = json.loads(directory_raw)["businesses"]
        if not isinstance(directory, list) or not all(isinstance(b, dict) and isinstance(b.get("id"), str) for b in directory):
            raise ValueError("not a list of businesses")
    except Exception:  # noqa: BLE001
        why.append("the directory could not be read (it is not what the directory route returns), so nothing will be changed blind")
        return out
    try:
        plans = json.loads(plans_raw)["plans"]
        if not isinstance(plans, list) or not all(isinstance(p, dict) and isinstance(p.get("name"), str) for p in plans):
            raise ValueError("not a list of plans")
    except Exception:  # noqa: BLE001
        why.append("the list of plans could not be read, so nothing will be changed blind")
        return out
    business = next((b for b in directory if b["id"] == business_id), None)
    if business is None:
        why.append(f"there is no business called {business_id}")
        return out
    out["name"] = business.get("name") if isinstance(business.get("name"), str) else None
    out["members"] = business.get("members") if isinstance(business.get("members"), int) else None
    if business.get("status") != "active":
        why.append(f"that business is {business.get('status')}, not active: only an active business can be moved off its trial")
    ends = parse_time(business.get("trial_ends_at")) if isinstance(business.get("trial_ends_at"), str) else None
    if "trial_ends_at" not in business:
        why.append("the directory has no trial information yet (no business has been started from the app)")
    elif ends is None:
        why.append("that business is not on a free trial: there is nothing to convert or extend")
    else:
        out["trialEndsAt"] = business["trial_ends_at"]
        left = (ends - now).total_seconds() / 86400
        out["state"] = f"running, {left:.1f} days left" if left > 0 else f"ENDED {(-left):.1f} days ago (the owner cannot sign in)"
    if op == "convert" and plan and plan not in {p["name"] for p in plans}:
        why.append(f"there is no plan called {plan}")
    if why:
        return out
    if op == "convert":
        out["warnings"].append("the trial is cleared and the business keeps the plan " + plan + ": the owner signs in as a normal member (a normal 30-day session)")
    else:
        out["warnings"].append(f"the trial runs {out['days']} more day(s), counted from the later of now and its current end")
    out["action"] = "apply"
    return out


def main():
    if len(sys.argv) != 4:
        sys.exit("usage: trial-guard.py <inputs.json> <directory.json> <plans.json>")
    def read(path):
        try:
            return open(path, encoding="utf-8").read()
        except OSError:
            return ""
    try:
        inputs = json.loads(read(sys.argv[1]))
        if not isinstance(inputs, dict):
            raise ValueError("not an object")
    except Exception:  # noqa: BLE001
        print(json.dumps({"action": "refuse", "business_id": None, "op": None, "plan": None, "days": None, "name": None, "members": None, "state": None, "trialEndsAt": None, "warnings": [], "reasons": ["the inputs could not be read, so nothing will be changed"]}, indent=1))
        sys.exit(2)
    text = lambda k: inputs.get(k) if isinstance(inputs.get(k), str) else None
    result = decide(text("business_id"), text("op"), text("plan"), text("days"), text("confirm"), read(sys.argv[2]), read(sys.argv[3]))
    print(json.dumps(result, indent=1))
    sys.exit(0 if result["action"] == "apply" else 2)


if __name__ == "__main__":
    main()
