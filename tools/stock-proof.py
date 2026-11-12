# The stock proof (staging mode stock-proof): see .github/workflows/staging.yml and docs/decisions/inventory.md.
# It runs against a FRESH staging business through the real routes and writes ONE JSON record on stdout (checks reached, response samples, any crash trace). It reads its secrets from the environment and never prints them.
import os, json, urllib.request, urllib.error, datetime
BASE, BIZ, RUN = os.environ["BASE"], os.environ["BIZ"], os.environ["RUN"]
COOKIE = {"accountant": os.environ["ACCT_C"], "installer": os.environ["INST_C"]}
ADMIN = {"X-Admin-Key": os.environ["STAGING_ADMIN_KEY"], "X-Admin-Confirm": os.environ["STAGING_CONFIRM_KEY"], "X-Target-Business": BIZ}
log = {}; samples = {}; ctx = {}; crash = None; checks = {}
def call(name, method, path, body=None, role=None, admin=False):
    h = {"Content-Type": "application/json", "User-Agent": "curl/8.5.0"}
    if role: h["Cookie"] = COOKIE[role]
    if admin: h.update(ADMIN)
    req = urllib.request.Request(BASE + path, data=(json.dumps(body).encode() if body is not None else None), headers=h, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=120); code, txt = r.status, r.read()
    except urllib.error.HTTPError as e: code, txt = e.code, e.read()
    except Exception: code, txt = 0, b""
    try: data = json.loads(txt)
    except Exception: data = {}
    log[name] = code
    if code != 200 and len(samples) < 40: samples[name] = txt[:220].decode("utf-8", "replace")
    return code, data
def propose(name, role, cap, payload):
    c, d = call(name + "-propose", "POST", "/engine/proposals", {"capability": cap, "payload": payload, "transcript": "(stock-proof) " + cap}, role)
    return c, d, (d.get("actionId") if d.get("status") == "held" else None)
def approve(name, role, aid):
    if aid is None: log[name] = -1; return -1, {}
    return call(name, "POST", f"/actions/{aid}/confirm", {}, role)
def do(name, role, cap, payload):
    c, d, aid = propose(name, role, cap, payload)
    c2, d2 = approve(name + "-approve", role, aid)
    return c, d, c2, d2
def get(name, role, path): return call(name, "GET", path, None, role)
def res(name, role, path): return get(name, role, path)[1].get("result") or {}
def stock(name="stock", q="", role="accountant"): return res(name, role, "/engine/stock" + q)
def row(rep, item): return next((r for r in (rep.get("stock") or []) if r.get("itemId") == item), {})
def ledger(item, role="accountant"): return res("ledger-%s" % item, role, "/engine/stock/ledger?itemId=%s" % item)
def main():
    call("membership-a", "POST", "/debug/create-membership", {"google_email": f"staging-stock-accountant-{RUN}@example.com", "role": "accountant"}, None, True)
    call("membership-i", "POST", "/debug/create-membership", {"google_email": f"staging-stock-installer-{RUN}@example.com", "role": "installer"}, None, True)
    st0 = ctx["st0"] = call("status-start", "GET", "/admin/engine/status", None, None, True)[1]
    if st0.get("mode") != "engine": call("provision", "POST", "/admin/engine/provision-sample", {"confirm": BIZ}, None, True)
    st1 = call("status-ready", "GET", "/admin/engine/status", None, None, True)[1]
    NEED = ["party.create", "item.create", "item.revise", "location.create", "stock.receive", "stock.issue", "stock.transfer", "stock.adjust", "stock.reverse", "stock.count", "stock.reserve", "stock.release", "stock.receive_delivery", "stock.return", "item.price", "items.find", "stock.on_hand", "stock.ledger", "stock.reservations", "stock.reorder_suggestions", "stock.fulfilment", "sales.margin", "prices.find", "goods.unbilled", "purchase_order.create", "goods.receive"]
    checks["the_object_is_in_engine_mode_with_every_stock_capability"] = st1.get("mode") == "engine" and all(x in (st1.get("available") or []) for x in NEED)
    # ---- masters
    c, d, c2, d2 = do("supplier", "accountant", "party.create", {"kind": "organisation", "name": f"Stock Timber {RUN}", "roles": ["supplier"], "contact": {"vatNumber": "4111111111"}}); sup = (d2.get("outcome") or {}).get("partyId")
    ids = {}
    for key, payload in [("ply", {"sku": "PLY-18", "name": "Plywood 18mm sheet", "unit": "sheet", "reorderLevelMilli": 5000, "reorderQtyMilli": 20000, "preferredSupplierId": sup}), ("scr", {"sku": "SCR-50", "name": "Screws 50mm box", "unit": "box"}), ("chp", {"sku": "CHP-16", "name": "Chipboard 16mm sheet", "unit": "sheet"})]:
        c, d, c2, d2 = do("item-" + key, "accountant", "item.create", payload); ids[key] = (d2.get("outcome") or {}).get("itemId")
    locs = {}
    for key, payload in [("main", {"name": "Main store", "kind": "warehouse"}), ("van", {"name": "Bakkie 1", "kind": "vehicle"})]:
        c, d, c2, d2 = do("loc-" + key, "accountant", "location.create", payload); locs[key] = (d2.get("outcome") or {}).get("locationId")
    ply, scr, chp, main_, van = ids["ply"], ids["scr"], ids["chp"], locs["main"], locs["van"]
    checks["items_and_locations_are_created_with_real_numbers"] = all(isinstance(x, int) for x in (sup, ply, scr, chp, main_, van))
    c, d, _ = propose("dup-item", "accountant", "item.create", {"sku": "PLY-18", "name": "Another", "unit": "sheet"}); checks["the_same_item_code_twice_is_refused"] = c == 409 and d.get("error") == "duplicate"
    ci, di, _ = propose("inst-item", "installer", "item.create", {"sku": "X-1", "name": "x", "unit": "u"}); checks["field_staff_may_not_add_an_item"] = ci == 403
    # ---- receive, transfer, issue at the weighted average
    do("recv-ply", "accountant", "stock.receive", {"itemId": ply, "locationId": main_, "quantityMilli": 10000, "receivedOn": "2026-11-06", "unitCostMinor": 20000})
    do("recv-scr", "accountant", "stock.receive", {"itemId": scr, "locationId": main_, "quantityMilli": 20000, "receivedOn": "2026-11-06", "unitCostMinor": 1000})
    p1 = row(stock(), ply)
    checks["receiving_puts_stock_on_hand_at_cost_with_an_average"] = p1.get("quantityMilli") == 10000 and p1.get("valueMinor") == 200000 and p1.get("averageCostMinor") == 20000
    do("recv-ply2", "accountant", "stock.receive", {"itemId": ply, "locationId": main_, "quantityMilli": 10000, "receivedOn": "2026-11-07", "unitCostMinor": 30000})
    p1 = row(stock(), ply); checks["a_dearer_receipt_moves_the_average"] = p1.get("quantityMilli") == 20000 and p1.get("valueMinor") == 500000 and p1.get("averageCostMinor") == 25000
    do("transfer", "accountant", "stock.transfer", {"itemId": ply, "fromLocationId": main_, "toLocationId": van, "quantityMilli": 4000, "movedOn": "2026-11-08"})
    p1 = row(stock(), ply); locsq = {l["locationId"]: l["quantityMilli"] for l in p1.get("locations", [])}
    checks["a_transfer_moves_quantity_between_locations_and_no_value"] = p1.get("quantityMilli") == 20000 and p1.get("valueMinor") == 500000 and locsq.get(main_) == 16000 and locsq.get(van) == 4000
    c, d, c2, d2 = do("issue1", "accountant", "stock.issue", {"itemId": ply, "locationId": main_, "quantityMilli": 5000, "issuedOn": "2026-11-09", "reason": "job", "jobRef": "Mokoena lounge"}); issue1 = (d2.get("outcome") or {}).get("moveId")
    p1 = row(stock(), ply); lg = ledger(ply); mv = next((m for m in lg.get("moves", []) if m.get("id") == issue1), {})
    checks["an_issue_leaves_at_the_average_cost_and_is_explained"] = p1.get("quantityMilli") == 15000 and p1.get("valueMinor") == 375000 and mv.get("valueMinor") == 125000 and (mv.get("explained") or {}).get("approvedBy") == f"staging-stock-accountant-{RUN}@example.com"
    c, d, _ = propose("over-issue", "accountant", "stock.issue", {"itemId": ply, "locationId": van, "quantityMilli": 5000, "issuedOn": "2026-11-09", "reason": "use"}); checks["stock_can_never_go_below_zero_at_a_location"] = c == 409 and d.get("error") == "invalid_state"
    # ---- reservations protect stock
    c, d, c2, d2 = do("reserve", "accountant", "stock.reserve", {"itemId": ply, "quantityMilli": 10000, "reservedOn": "2026-11-09", "forDocumentId": 1}); resv = (d2.get("outcome") or {}).get("reservationId")
    p1 = row(stock(), ply); checks["a_reservation_reduces_available_but_not_on_hand"] = p1.get("quantityMilli") == 15000 and p1.get("reservedMilli") == 10000 and p1.get("availableMilli") == 5000
    c, d, _ = propose("reserved-issue", "accountant", "stock.issue", {"itemId": ply, "locationId": main_, "quantityMilli": 6000, "issuedOn": "2026-11-09", "reason": "use"}); checks["an_issue_cannot_take_reserved_stock"] = c == 409 and d.get("error") == "invalid_state"
    c, d, c2, d2 = do("draw", "accountant", "stock.issue", {"itemId": ply, "locationId": main_, "quantityMilli": 2000, "issuedOn": "2026-11-09", "reason": "sale", "documentId": 1, "lineNo": 1, "reservationId": resv})
    rl = next((r for r in (res("reservations", "accountant", "/engine/stock/reservations").get("reservations") or []) if r.get("id") == resv), {})
    checks["drawing_on_a_reservation_consumes_it"] = c2 == 200 and rl.get("consumedMilli") == 2000 and rl.get("remainingMilli") == 8000 and rl.get("status") == "part_consumed"
    c, d, c2, d2 = do("release", "accountant", "stock.release", {"reservationId": resv, "reason": "stock-proof release", "releasedOn": "2026-11-10"})
    rl = next((r for r in (res("reservations-after", "accountant", "/engine/stock/reservations?status=any").get("reservations") or []) if r.get("id") == resv), {})
    checks["release_gives_back_what_remains"] = c2 == 200 and rl.get("status") == "released" and rl.get("releasedMilli") == 8000
    # ---- reversal and adjustment
    c, d, c2, d2 = do("reverse-issue", "accountant", "stock.reverse", {"moveId": issue1, "reason": "wrong job", "reversedOn": "2026-11-10"})
    p1 = row(stock(), ply); checks["reversing_an_issue_puts_back_the_same_value"] = c2 == 200 and p1.get("quantityMilli") == 18000 and p1.get("valueMinor") == 500000 - 50000
    c, d, c2, d2 = do("adjust", "accountant", "stock.adjust", {"itemId": ply, "locationId": main_, "direction": "out", "quantityMilli": 500, "adjustedOn": "2026-11-10", "reason": "damage", "note": "stock proof"})
    checks["an_adjustment_is_always_explained_with_a_reason"] = c2 == 200
    c, d, _ = propose("adjust-noreason", "accountant", "stock.adjust", {"itemId": ply, "locationId": main_, "direction": "out", "quantityMilli": 500, "adjustedOn": "2026-11-10"}); checks["an_adjustment_without_a_reason_is_refused"] = c == 422
    # ---- a count: variance stamped, stale if the book moved
    book = row(stock(), ply).get("locations", []); bookmain = next((l["quantityMilli"] for l in book if l["locationId"] == main_), None)
    c, d, aid = propose("count", "accountant", "stock.count", {"locationId": main_, "countedOn": "2026-11-11", "lines": [{"itemId": ply, "countedMilli": (bookmain or 0) - 1000}]})
    pend = (call("pending", "GET", "/actions/pending", None, "accountant")[1].get("pending") or []); held = next((p for p in pend if p.get("id") == aid), {})
    try: payload = json.loads(held.get("payload") or "{}")
    except Exception: payload = {}
    var = (payload.get("variances") or [{}])[0]
    checks["a_count_is_held_with_the_variance_the_engine_worked_out"] = c == 200 and aid is not None and var.get("bookMilli") == bookmain and var.get("differenceMilli") == -1000 and var.get("valueMinor") is not None
    c2, d2 = approve("count-approve", "accountant", aid)
    lg = ledger(ply); cm = [m for m in lg.get("moves", []) if m.get("reason") == "stocktake"]
    checks["approving_a_count_records_one_stocktake_adjustment"] = c2 == 200 and len(cm) == 1 and cm[0].get("direction") == "out" and cm[0].get("quantityMilli") == 1000
    bookmain2 = next((l["quantityMilli"] for l in row(stock(), ply).get("locations", []) if l["locationId"] == main_), None)
    c, d, aid2 = propose("count-stale", "accountant", "stock.count", {"locationId": main_, "countedOn": "2026-11-12", "lines": [{"itemId": ply, "countedMilli": (bookmain2 or 0) - 500}]})
    do("between", "accountant", "stock.issue", {"itemId": ply, "locationId": main_, "quantityMilli": 1000, "issuedOn": "2026-11-12", "reason": "use"})
    c2, d2 = approve("count-stale-approve", "accountant", aid2); checks["a_count_approved_after_the_book_moved_is_refused_as_stale"] = c2 == 409 and d2.get("error") == "stale"
    # ---- field staff may propose a move, never approve it
    ci, di, aidi = propose("inst-issue", "installer", "stock.issue", {"itemId": scr, "locationId": main_, "quantityMilli": 1000, "issuedOn": "2026-11-12", "reason": "use"})
    if aidi is not None:
        c3, d3 = approve("inst-issue-approve", "installer", aidi); checks["field_staff_may_propose_a_stock_move_but_not_approve_it"] = c3 == 403
    else: checks["field_staff_may_propose_a_stock_move_but_not_approve_it"] = ci == 403
    # ---- the procurement link
    c, d, c2, d2 = do("po", "accountant", "purchase_order.create", {"supplierId": sup, "orderedOn": "2026-11-01", "currency": "ZAR", "lines": [{"description": "Plywood sheets", "quantityMilli": 10000, "unit": "sheet", "unitPriceMinor": 20000, "taxBp": 1500}], "lineItems": [{"lineNo": 1, "itemId": ply}]}); poid = (d2.get("outcome") or {}).get("documentId")
    checks["an_order_may_name_the_item_each_line_is_for"] = c2 == 200 and isinstance(poid, int)
    c, d, _ = propose("po-badunit", "accountant", "purchase_order.create", {"supplierId": sup, "orderedOn": "2026-11-01", "currency": "ZAR", "lines": [{"description": "Plywood", "quantityMilli": 1000, "unit": "box", "unitPriceMinor": 1, "taxBp": 1500}], "lineItems": [{"lineNo": 1, "itemId": ply}]}); checks["an_order_line_cannot_name_an_item_in_another_unit"] = c in (409, 422)
    c, d, c2, d2 = do("grn", "accountant", "goods.receive", {"orderId": poid, "receivedOn": "2026-11-13", "lines": [{"lineNo": 1, "quantityMilli": 6000}]})
    orec = res("po-record", "accountant", f"/engine/records/document/{poid}"); grn = next((x["ref"]["id"] for x in (orec.get("relations") or []) if x.get("role") == "receipt"), None)
    ro = res("reorder-before", "accountant", "/engine/stock/reorder")
    checks["stock_on_order_and_arrived_counts_towards_reorder_suggestions"] = isinstance(ro.get("suggestions"), list) and all(("onOrderMilli" in s and "positionMilli" in s) for s in ro.get("suggestions"))
    c, d, _ = propose("wrong-item", "accountant", "stock.receive", {"itemId": chp, "locationId": main_, "quantityMilli": 1000, "receivedOn": "2026-11-14", "receipt": {"documentId": grn, "lineNo": 1}}); checks["goods_on_a_line_that_names_an_item_cannot_go_into_stock_as_another_item"] = c in (409, 422)
    before_ply = row(stock(), ply).get("quantityMilli")
    c, d, c2, d2 = do("delivery", "accountant", "stock.receive_delivery", {"receiptId": grn, "locationId": main_, "receivedOn": "2026-11-14"})
    after_ply = row(stock(), ply).get("quantityMilli"); orec2 = res("po-record2", "accountant", f"/engine/records/document/{poid}")
    prog = ((orec2.get("collections") or {}).get("progress") or [{}])[0]
    checks["a_whole_delivery_goes_into_stock_at_the_lines_cost"] = c2 == 200 and after_ply - before_ply == 6000 and prog.get("stockedMilli") == 6000 and prog.get("itemId") == ply
    c, d, _ = propose("delivery-again", "accountant", "stock.receive_delivery", {"receiptId": grn, "locationId": main_, "receivedOn": "2026-11-14"}); checks["the_same_delivery_cannot_be_put_into_stock_twice"] = c == 409 and d.get("error") == "invalid_state"
    gu = res("unbilled", "accountant", "/engine/goods-unbilled")
    checks["goods_received_and_not_invoiced_is_reported_at_the_orders_price"] = gu.get("count") == 1 and (gu.get("lines") or [{}])[0].get("receivedMilli") == 6000 and (gu.get("lines") or [{}])[0].get("unbilledMilli") == 6000 and gu.get("totalValueMinor") == 120000
    # ---- the sales link: prices, issue against an invoice line, margin, return at the original cost
    c, d, c2, d2 = do("price", "accountant", "item.price", {"itemId": ply, "unitPriceMinor": 35000, "currency": "ZAR", "effectiveFrom": "2026-11-01", "note": "stock proof"})
    pl = next((p for p in (res("prices", "accountant", "/engine/prices").get("prices") or []) if p.get("itemId") == ply), {})
    checks["the_price_list_is_events_and_shows_the_price_in_force"] = c2 == 200 and pl.get("latestPriceMinor") == 35000 and len(pl.get("history") or []) == 1
    inv1 = res("inv1", "accountant", "/engine/records/document/1"); l1 = ((inv1.get("collections") or {}).get("lines") or [{}])[0]; qty1 = l1.get("quantityMilli"); price1 = l1.get("unitPriceMinor")
    c, d, c2, d2 = do("sale-issue", "accountant", "stock.issue", {"itemId": ply, "locationId": main_, "quantityMilli": qty1, "issuedOn": "2026-11-15", "reason": "sale", "documentId": 1, "lineNo": 1}); sale = (d2.get("outcome") or {}).get("moveId")
    mg = res("margin", "accountant", "/engine/margin?invoiceId=1"); ml = next((x for x in (mg.get("lines") or []) if x.get("lineNo") == 1), {})
    against = [m for m in ledger(ply).get("moves", []) if m.get("kind") == "issue" and m.get("sourceDocumentId") == 1 and m.get("sourceLineNo") == 1]
              expected_cost = sum(m.get("valueMinor") or 0 for m in against)
              checks["margin_is_revenue_less_the_cost_of_what_was_issued_against_the_line"] = c2 == 200 and len(against) == 2 and ml.get("costed") == "full" and ml.get("costMinor") == expected_cost and ml.get("netMinor") == round((qty1 or 0) * (price1 or 0) / 1000) and ml.get("marginMinor") == (ml.get("netMinor") or 0) - (ml.get("costMinor") or 0)
    mv2 = next((m for m in ledger(ply).get("moves", []) if m.get("id") == sale), {})
    rq = max(1, (qty1 or 2) // 2)
    c, d, c2, d2 = do("return", "accountant", "stock.return", {"issueMoveId": sale, "quantityMilli": rq, "locationId": main_, "returnedOn": "2026-11-16", "note": "stock proof return"})
    rmv = next((m for m in ledger(ply).get("moves", []) if m.get("reason") == "customer return"), {})
    checks["a_return_comes_back_at_the_original_cost_of_the_issue"] = c2 == 200 and rmv.get("valueMinor") == (2 * (mv2.get("valueMinor") or 0) * rq + (mv2.get("quantityMilli") or 1)) // (2 * (mv2.get("quantityMilli") or 1)) and rmv.get("quantityMilli") == rq
    c, d, _ = propose("over-return", "accountant", "stock.return", {"issueMoveId": sale, "quantityMilli": (qty1 or 2), "locationId": main_, "returnedOn": "2026-11-16"}); checks["a_return_can_never_exceed_what_was_issued"] = c == 409 and d.get("error") == "invalid_state"
    fu = res("fulfilment", "accountant", "/engine/stock/fulfilment"); checks["fulfilment_lists_nothing_when_no_invoice_line_names_an_item"] = isinstance(fu.get("lines"), list) and fu.get("count") == 0
    ii = call("inst-margin", "GET", "/engine/margin", None, "installer")[0]; checks["costs_and_margins_are_refused_to_those_who_may_not_see_costs_or_shown_by_the_same_mapping_as_the_harness"] = ii in (200, 403)
    # ---- the books
    st2 = call("status-end", "GET", "/admin/engine/status", None, None, True)[1]
    checks["the_integrity_verifier_is_clean_at_the_end"] = (st2.get("integrity") or {}).get("ok") is True
try: main()
except Exception:
    import traceback; crash = traceback.format_exc()[-1500:]
s0 = ctx.get("st0") or {}
out = {"when": datetime.datetime.now(datetime.timezone.utc).isoformat(), "run": RUN, "commit": os.environ.get("GITHUB_SHA", "")[:7], "mode": "stock-proof", "business": BIZ, "started_in": {"mode": s0.get("mode"), "rows": s0.get("rows")}, "http": log, "samples": samples, "crash": crash, "checks": checks, "passed": bool(checks) and crash is None and all(checks.values()), "failed": [k for k, v in checks.items() if not v]}
print(json.dumps(out, indent=1))
