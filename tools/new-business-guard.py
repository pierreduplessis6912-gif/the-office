#!/usr/bin/env python3
"""Decides what the production "new business" workflow may do. It WRITES NOTHING and calls nothing: it reads the directory and the email-clash answer the workflow fetched, and the four inputs, and prints a decision.

  action "create"  a new business, the owner's email is free: the workflow may create it
  action "resume"  the business exists but has NO members (a half-created one): the workflow may complete it with its owner
  action "refuse"  anything else (exit status 2): the workflow stops before any write and goes red, with the reasons

Usage: new-business-guard.py <directory.json> <conflicts.json>      Environment: BUSINESS_ID, BUSINESS_NAME, OWNER_EMAIL, CONFIRM
Never decides blind: a directory or a clash answer that cannot be read is a refusal. The input checks come FIRST, so a bad id or email is reported even when the files could not be fetched.

The owner's email is personal data: the output carries it only masked, and never says which OTHER business an email belongs to.
"""
import json
import os
import re
import sys

ID_OK = re.compile(r"[a-z0-9][a-z0-9-]{1,38}[a-z0-9]")           # the server's own rule (directory.ts BUSINESS_ID_PATTERN)
RESERVED = {"admin", "api", "app", "auth", "debug", "demo", "health", "office", "staging", "test", "www"}
EMAIL_OK = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def mask(email):
    local, _, domain = email.partition("@")
    return (local[:1] + "***@" + domain) if domain else "***"


def decide(business_id, name, owner, confirm, directory_raw, conflicts_raw):
    business_id = (business_id or "").strip() if business_id is not None else ""
    confirm = confirm if confirm is not None else ""
    owner = (owner or "").strip().lower() if owner is not None else ""     # what the server does too (normaliseEmail)
    name = re.sub(r"\s+", " ", name or "").strip()
    out = {"action": "refuse", "business_id": business_id or None, "name": name or None, "ownerMasked": mask(owner) if owner else None, "existing": False, "warnings": [], "reasons": []}
    why = out["reasons"]
    if not ID_OK.fullmatch(business_id):
        why.append("a business id is 3 to 40 lower-case letters, digits and hyphens, not starting or ending with a hyphen")
    elif business_id in RESERVED or business_id.startswith("staging-"):
        why.append(f"'{business_id}' is reserved (it could be mistaken for a system or staging name): choose another id")
    if confirm != business_id:
        why.append("to create it, type the business id exactly in the confirm box")
    if not (2 <= len(name) <= 80) or CONTROL.search(name) or "<" in name or ">" in name:
        why.append("the business name must be 2 to 80 characters, with no control characters and no < or >")
    local = owner.partition("@")[0]
    if not owner or len(owner) > 254 or len(local) > 64 or not EMAIL_OK.fullmatch(owner):
        why.append("the owner's email address is not a valid email address")
    if why:
        return out
    try:
        directory = json.loads(directory_raw)["businesses"]
        if not isinstance(directory, list) or not all(isinstance(b, dict) and isinstance(b.get("id"), str) for b in directory):
            raise ValueError("not a list of businesses")
    except Exception:  # noqa: BLE001
        why.append("the directory could not be read (it is not what the directory route returns), so nothing will be created blind")
        return out
    try:
        conflicts = json.loads(conflicts_raw)["conflicts"]
        if not isinstance(conflicts, list) or not all(isinstance(c, dict) and isinstance(c.get("email"), str) for c in conflicts):
            raise ValueError("not a list of conflicts")
    except Exception:  # noqa: BLE001
        why.append("the answer to 'is this email already taken?' could not be read, so nothing will be created blind")
        return out
    if owner in {c["email"].strip().lower() for c in conflicts}:
        why.append("that email address already belongs to another business: one email can sign in to only one business")
    existing = next((b for b in directory if b["id"] == business_id), None)
    if existing is not None:
        out["existing"] = True
        members = existing.get("members") if isinstance(existing.get("members"), int) else None
        if existing.get("status") not in (None, "active"):
            why.append("that business exists but is not active")
        elif members is None:
            why.append("that business exists and its member count could not be read")
        elif members > 0:
            why.append(f"that business already exists and already has {members} member(s): this creates NEW businesses. To add someone to an existing business use the add-member route")
    if why:
        return out
    if out["existing"]:
        out["action"] = "resume"
        out["warnings"].append("that business already exists with no members (a half-created one): it will be completed with this owner")
    else:
        out["action"] = "create"
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: new-business-guard.py <directory.json> <conflicts.json>")
    def read(path):
        try:
            return open(path, encoding="utf-8").read()
        except OSError:
            return ""
    result = decide(os.environ.get("BUSINESS_ID"), os.environ.get("BUSINESS_NAME"), os.environ.get("OWNER_EMAIL"), os.environ.get("CONFIRM"), read(sys.argv[1]), read(sys.argv[2]))
    print(json.dumps(result, indent=1))
    sys.exit(0 if result["action"] in ("create", "resume") else 2)


if __name__ == "__main__":
    main()
