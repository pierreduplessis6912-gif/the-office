#!/usr/bin/env python3
"""Decides what the production "add a member" workflow may do. It WRITES NOTHING and calls nothing: it reads the inputs and three answers the workflow fetched, and prints a decision.

  action "add"     the business exists and is active, the email belongs to no OTHER business and is not already a member here, the role is valid: the workflow may add it
  action "refuse"  anything else (exit status 2): the workflow stops before any write and goes red, with the reasons

Usage: add-member-guard.py <inputs.json> <directory.json> <conflicts.json> <membership.json>
  inputs.json: business_id, member_email, role, confirm. They arrive in a FILE, never in environment variables (GitHub prints every step's env block in its log and the repository is public).
  directory.json: the directory listing; conflicts.json: emails that already belong to ANOTHER business; membership.json: whether this email is already a member of THIS business.
Never decides blind: anything that cannot be read is a refusal. Input checks come first. The member's email is personal data: the output carries it only masked, and never says which OTHER business an email belongs to.

One safety rule beyond the obvious: a business that already has more than one member cannot be given another OWNER this way (a typed id and a typo must not be able to hand an established business to someone). An accountant or an installer can be added to any business.
"""
import json
import re
import sys

ID_OK = re.compile(r"[a-z0-9][a-z0-9-]{1,38}[a-z0-9]")           # the server's own rule (directory.ts BUSINESS_ID_PATTERN)
EMAIL_OK = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
ROLES = ("owner", "accountant", "installer")                      # worker/src/auth.ts ROLE_CAPABILITIES


def mask(email):
    local, _, domain = email.partition("@")
    return (local[:1] + "***@" + domain) if domain else "***"


def decide(business_id, email, role, confirm, directory_raw, conflicts_raw, membership_raw):
    business_id = (business_id or "").strip() if business_id is not None else ""
    confirm = confirm if confirm is not None else ""
    email = (email or "").strip().lower() if email is not None else ""        # what the server does too
    role = (role or "").strip() if role is not None else ""
    out = {"action": "refuse", "business_id": business_id or None, "role": role or None, "memberMasked": mask(email) if email else None, "membersBefore": None, "warnings": [], "reasons": []}
    why = out["reasons"]
    if not ID_OK.fullmatch(business_id):
        why.append("a business id is 3 to 40 lower-case letters, digits and hyphens, not starting or ending with a hyphen")
    if confirm != business_id:
        why.append("to add a member, type the business id exactly in the confirm box")
    local = email.partition("@")[0]
    if not email or len(email) > 254 or len(local) > 64 or not EMAIL_OK.fullmatch(email):
        why.append("the member's email address is not a valid email address")
    if role not in ROLES:
        why.append("the role must be one of: " + ", ".join(ROLES))
    if why:
        return out
    try:
        directory = json.loads(directory_raw)["businesses"]
        if not isinstance(directory, list) or not all(isinstance(b, dict) and isinstance(b.get("id"), str) for b in directory):
            raise ValueError("not a list of businesses")
    except Exception:  # noqa: BLE001
        why.append("the directory could not be read (it is not what the directory route returns), so nobody will be added blind")
        return out
    try:
        conflicts = json.loads(conflicts_raw)["conflicts"]
        if not isinstance(conflicts, list) or not all(isinstance(c, dict) and isinstance(c.get("email"), str) for c in conflicts):
            raise ValueError("not a list of conflicts")
    except Exception:  # noqa: BLE001
        why.append("the answer to 'does this email belong to another business?' could not be read, so nobody will be added blind")
        return out
    try:
        membership = json.loads(membership_raw)
        if not isinstance(membership, dict) or not isinstance(membership.get("found"), bool):
            raise ValueError("not a membership answer")
    except Exception:  # noqa: BLE001
        why.append("the answer to 'is this person already a member here?' could not be read, so nobody will be added blind")
        return out
    business = next((b for b in directory if b["id"] == business_id), None)
    members = None
    if business is None:
        why.append(f"there is no business called {business_id}")
    elif business.get("status") not in (None, "active"):
        why.append("that business exists but is not active")
    else:
        members = business.get("members") if isinstance(business.get("members"), int) else None
        out["membersBefore"] = members
        if members is None:
            why.append("that business's member count could not be read")
    if email in {c["email"].strip().lower() for c in conflicts}:
        why.append("that email address already belongs to another business: one email can sign in to only one business")
    if membership["found"]:
        why.append(f"that person is already a member of this business (as {membership.get('role')}): there is nothing to add")
    if role == "owner" and members is not None and members > 1:
        why.append(f"that business already has {members} members: another OWNER cannot be added this way (add an accountant or an installer, or change a role by hand)")
    if why:
        return out
    if members == 0 and role != "owner":
        out["warnings"].append("that business has no members yet: the first person is usually its owner")
    out["action"] = "add"
    return out


def main():
    if len(sys.argv) != 5:
        sys.exit("usage: add-member-guard.py <inputs.json> <directory.json> <conflicts.json> <membership.json>")
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
        print(json.dumps({"action": "refuse", "business_id": None, "role": None, "memberMasked": None, "membersBefore": None, "warnings": [], "reasons": ["the inputs could not be read, so nobody will be added"]}, indent=1))
        sys.exit(2)
    text = lambda k: inputs.get(k) if isinstance(inputs.get(k), str) else None
    result = decide(text("business_id"), text("member_email"), text("role"), text("confirm"), read(sys.argv[2]), read(sys.argv[3]), read(sys.argv[4]))
    print(json.dumps(result, indent=1))
    sys.exit(0 if result["action"] == "add" else 2)


if __name__ == "__main__":
    main()
