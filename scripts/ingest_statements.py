#!/usr/bin/env python3
"""Offline ingest of financial statements (PDF + CSV) into a local JSON portfolio.

LOCAL-ONLY by design: reads the gitignored private/ tree and writes the
gitignored data/finance/statements.json. The Homunculus server only ever reads
that sanitized JSON — it never touches the source files — so the runtime stays
free of parsing dependencies and the raw statements stay off the request path.

Directory layout it walks (empty folders are skipped):
    private/Bank/Checking/*.pdf       deposit account  (kind "checking")
    private/Bank/Saving/*.pdf         deposit account  (kind "savings")
    private/Cards/Gemini/*.pdf        Gemini card      (PDF)
    private/Cards/Amazon/*.pdf        Chase Prime Visa (PDF)
    private/Cards/PayPal/*.pdf        Synchrony PayPal (PDF)
    private/Cards/AMEX/Blue/*.csv     Amex Blue        (CSV, activity only)
    private/Cards/AMEX/Gold/*.csv     Amex Gold        (CSV, activity only)
    private/Cards/Apple/*.csv         Apple Card       (CSV, merchant+category)
    private/Cards/Discover/*.csv      Discover         (CSV, activity only)

Transaction `amount` is normalized across all issuers: negative = spend
(outflow / purchase), positive = money in (deposit / card payment / credit).

Requires pdfplumber (dev-only, NOT a project runtime dep):
    python3 -m venv .venv && ./.venv/bin/pip install pdfplumber
    ./.venv/bin/python scripts/ingest_statements.py
"""
from __future__ import annotations
import csv
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIVATE_DIR = os.path.join(ROOT, "private")
OUT_DIR = os.path.join(ROOT, "data", "finance")
OUT_PATH = os.path.join(OUT_DIR, "statements.json")

MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"], 1)}

CATEGORY_RULES = [
    ("PAYROLL", ("Income", "Payroll")),
    ("UI BENEFIT", ("Income", "Unemployment")),
    ("RDA CHECKING DEPOSIT", ("Income", "Deposit")),
    ("INTEREST CHARGE", ("Fees", "Interest")),
    ("INTEREST", ("Income", "Interest")),
    ("STATEMENT CREDIT", ("Payment", "Statement credit")),
    ("PAYMENT - THANK YOU", ("Payment", "Card payment")),
    ("PAYMENT THANK", ("Payment", "Card payment")),
    ("ACH PAYMENT", ("Payment", "Card payment")),
    ("ACH DEPOSIT", ("Payment", "Card payment")),
    ("PAYMENT", ("Payment", "Card payment")),
    ("TRANSFER FROM", ("Transfer", "Account transfer")),
    ("INST XFER", ("Transfer", "Internal transfer")),
    ("MORTGAGE", ("Housing", "Mortgage")),
    ("HOME DEPOT", ("Home", "Home Depot")),
    ("TRUE VALUE", ("Home", "True Value")),
    ("TRACTOR SUPPLY", ("Home", "Tractor Supply")),
    ("HARDWARE", ("Home", "Hardware")),
    ("APPLECARD", ("Credit card", "Apple Card")),
    ("AMEX", ("Credit card", "Amex")),
    ("DISCOVER", ("Credit card", "Discover")),
    ("SYNCHRONY", ("Credit card", "Synchrony")),
    ("GEMINI", ("Credit card", "Gemini")),
    ("NETFLIX", ("Subscriptions", "Netflix")),
    ("HBO", ("Subscriptions", "HBO Max")),
    ("PRIME VIDEO", ("Subscriptions", "Prime Video")),
    ("APPLE.COM/BILL", ("Subscriptions", "Apple")),
    ("AMAZON DIGITAL", ("Subscriptions", "Amazon Digital")),
    ("TESLA, INC", ("Subscriptions", "Tesla")),
    ("CHUCKE", ("Entertainment", "Chuck E Cheese")),
    ("AMAZON", ("Shopping", "Amazon")),
    ("AMZN", ("Shopping", "Amazon")),
    ("PAYPAL PURCHASE", ("Shopping", "PayPal")),
    ("WAL-MART", ("Groceries", "Walmart")),
    ("WALMART", ("Groceries", "Walmart")),
    ("WM SUPERCENTER", ("Groceries", "Walmart")),
    ("TARGET", ("Shopping", "Target")),
    ("ACADEMY SPORTS", ("Shopping", "Academy")),
    ("ACADEMY", ("Shopping", "Academy")),
    # Additional merchants (shrink the "Other" bucket)
    ("TIRES", ("Auto", "Tires")),
    ("WHEELERSHIP", ("Auto", "Auto parts")),
    ("AUTO PART", ("Auto", "Auto parts")),
    ("O'REILLY", ("Auto", "O'Reilly")),
    ("OREILLY", ("Auto", "O'Reilly")),
    ("EXXON", ("Auto", "Exxon")),
    ("MOTOR V", ("Auto", "Vehicle reg")),
    ("TRACTOR", ("Home", "Tractor Supply")),
    ("SCHEELS", ("Shopping", "Scheels")),
    ("ROSS", ("Shopping", "Ross")),
    ("TJMAXX", ("Shopping", "TJ Maxx")),
    ("TJ MAXX", ("Shopping", "TJ Maxx")),
    ("BEALLS", ("Shopping", "Bealls")),
    ("OLLIE", ("Shopping", "Ollie's")),
    ("BURLINGTON", ("Shopping", "Burlington")),
    ("DICK'S SPORTING", ("Shopping", "Dick's")),
    ("DICKS SPORTING", ("Shopping", "Dick's")),
    ("SPORTS WORLD", ("Shopping", "Sports World")),
    ("HORANEY", ("Shopping", "Horaney's")),
    ("KAY", ("Shopping", "Kay Jewelers")),
    ("TACO BELL", ("Dining", "Taco Bell")),
    ("MCDONALD", ("Dining", "McDonald's")),
    ("TEXAS ROADHOUSE", ("Dining", "Texas Roadhouse")),
    ("AUNTIE ANNE", ("Dining", "Auntie Anne's")),
    ("WHATABURGER", ("Dining", "Whataburger")),
    ("SONIC", ("Dining", "Sonic")),
    ("VZWRLSS", ("Utilities", "Verizon")),
    ("VERIZON", ("Utilities", "Verizon")),
    ("ETEX TELEPHONE", ("Utilities", "ETEX Telephone")),
    ("MAGNOLIA HOTEL", ("Travel", "Magnolia Hotel")),
    ("DIAGNOSTIC CLINIC", ("Health", "Clinic")),
    ("J & M SERVICES", ("Services", "J & M Services")),
    ("PUSCIFER", ("Entertainment", "Concert")),
    ("TESLA SUPERCHARGER", ("Auto", "Tesla Supercharger")),
    ("LOAN PAY", ("Auto", "Auto loan")),
    ("CURSOR", ("Software", "Cursor")),
    ("ANTHROPIC", ("Software", "Anthropic")),
    ("CLAUDE", ("Software", "Anthropic")),
    ("BLUEHOST", ("Software", "Bluehost")),
    ("MICROSOFT", ("Software", "Microsoft")),
    ("PLAYSTATION", ("Software", "PlayStation")),
    ("STUDY.COM", ("Education", "Study.com")),
    ("UNIVERSITY", ("Education", "University")),
    ("CHICKEN EXPRESS", ("Dining", "Chicken Express")),
    ("DONUT", ("Dining", "Daylight Donuts")),
    ("FRESH 803", ("Dining", "Fresh")),
    ("EYE CARE", ("Health", "Eye Care")),
    ("ROLLING MEADOWS", ("Health", "Vet")),
    ("PAYPAL", ("Shopping", "PayPal")),
    ("FARM BUREAU", ("Insurance", "Farm Bureau")),
    ("MEMBERSHIP", ("Insurance", "Membership")),
    ("WATER", ("Utilities", "Water")),
    ("WASTE", ("Utilities", "Waste")),
    ("UPSHUR RURAL ELE", ("Utilities", "Electric")),
    ("TOBACCO", ("Misc", "Tobacco Junction")),
]


# Collapse issuer-specific category synonyms into one canonical set.
NORMALIZE = {
    "Grocery": "Groceries", "Supermarkets": "Groceries",
    "Restaurant": "Dining", "Restaurants": "Dining",
    "Medical": "Health", "Gas": "Auto", "Automotive": "Auto",
    "Merchandise": "Shopping", "Department Stores": "Shopping",
    "Gas Stations": "Auto", "Services": "Services",
}


def norm_cat(c: str) -> str:
    return NORMALIZE.get(c, c)


def categorize(desc: str) -> tuple[str, str]:
    up = desc.upper()
    for kw, (cat, payee) in CATEGORY_RULES:
        if kw in up:
            return (norm_cat(cat), payee)
    token = re.split(r"\s{2,}|\\|\d{3,}", desc.strip())[0].strip()
    return ("Other", (token[:24] or "Misc"))


def money(s: str) -> float:
    return float(s.replace(",", "").replace("$", "").strip())


def iso_mdy(s: str) -> str:
    """MM/DD/YY or MM/DD/YYYY -> ISO."""
    m, d, y = s.split("/")
    if len(y) == 2:
        y = "20" + y
    return f"{y}-{int(m):02d}-{int(d):02d}"


def iso_mmdd(mmdd: str, from_iso: str, to_iso: str) -> str:
    m, d = mmdd.split("/")
    for iso in (from_iso, to_iso):
        cand = f"{iso[:4]}-{int(m):02d}-{int(d):02d}"
        if from_iso <= cand <= to_iso:
            return cand
    return f"{from_iso[:4]}-{int(m):02d}-{int(d):02d}"


def read_lines(path: str) -> list[str]:
    import pdfplumber
    lines: list[str] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            lines.extend((page.extract_text() or "").splitlines())
    return lines


def tx(date, desc, amount, cat=None, payee=None, **extra) -> dict:
    c, p = categorize(desc)
    out = {"date": date, "description": re.sub(r"\s+", " ", desc).strip(),
           "amount": round(amount, 2), "category": cat or c, "payee": payee or p}
    out.update({k: v for k, v in extra.items() if v})
    return out


# ── TBT deposit statements (Bank/*) ───────────────────────────────────────────
DEP_TX_RE = re.compile(r"^(\d{2}/\d{2}/\d{2})\s+(.*?)\s+([\d,]+\.\d{2})(-?)\s*$")
DAILY_PAIR_RE = re.compile(r"(\d{2}/\d{2})\s+([\d,]+\.\d{2})")


def parse_deposit(path: str) -> dict | None:
    lines = read_lines(path)
    full = "\n".join(lines)
    acct = re.search(r"Account Number\s+(\d+)", full)
    frm = re.search(r"Date From\s+(\d{2}/\d{2}/\d{2})", full)
    to = re.search(r"Date To\s+(\d{2}/\d{2}/\d{2})", full)
    if not (acct and frm and to):
        return None
    from_iso, to_iso = iso_mdy(frm.group(1)), iso_mdy(to.group(1))
    bals = re.findall(r"Balance on\s*\d{2}/\d{2}/\d{2}\s+([\d,]+\.\d{2})", full)
    txns, daily, section = [], [], None
    for ln in lines:
        s = ln.strip()
        if "Deposits and Other Credits" in s: section = "credit"; continue
        if "Withdrawals and Other Debits" in s: section = "debit"; continue
        if "Daily Balance Information" in s: section = "daily"; continue
        if s.startswith(("Date Description", "Date Balance")) or "Interest Rate" in s: continue
        if section in ("credit", "debit"):
            m = DEP_TX_RE.match(s)
            if m:
                amt = money(m.group(3))
                signed = -amt if (section == "debit" or m.group(4) == "-") else amt
                txns.append(tx(iso_mdy(m.group(1)), m.group(2), signed))
        elif section == "daily":
            for mm, bal in DAILY_PAIR_RE.findall(s):
                daily.append({"date": iso_mmdd(mm, from_iso, to_iso), "balance": money(bal)})
    return {"account": acct.group(1), "from": from_iso, "to": to_iso,
            "openingBalance": money(bals[0]) if bals else None,
            "closingBalance": money(bals[1]) if len(bals) > 1 else None,
            "totalDeposits": round(sum(t["amount"] for t in txns if t["amount"] > 0), 2),
            "totalDebits": round(sum(-t["amount"] for t in txns if t["amount"] < 0), 2),
            "transactions": txns, "dailyBalances": daily}


# ── Gemini card (Cards/Gemini) ────────────────────────────────────────────────
GEM_TX_RE = re.compile(r"^(\d{9,})\s+(\d{2}/\d{2}/\d{2})\s+(\d{2}/\d{2}/\d{2})\s+(.*?)\s+(\(?)\$([\d,]+\.\d{2})\)?\s*$")
PERIOD_RE = re.compile(r"(\w+) (\d{1,2}), (\d{4}) to (\w+) (\d{1,2}), (\d{4})")


def _f(full, pat):
    m = re.search(pat, full)
    return money(m.group(1)) if m else None


def parse_gemini(path: str) -> dict | None:
    lines = read_lines(path)
    full = "\n".join(lines)
    acct = re.search(r"Account Number:?\s+(\d+)", full)
    per = PERIOD_RE.search(full)
    if not (acct and per):
        return None
    from_iso = f"{per.group(3)}-{MONTHS[per.group(1)]:02d}-{int(per.group(2)):02d}"
    to_iso = f"{per.group(6)}-{MONTHS[per.group(4)]:02d}-{int(per.group(5)):02d}"
    due = re.search(r"Payment Due Date\s+(\d{2}/\d{2}/\d{2})", full)
    txns = []
    for i, ln in enumerate(lines):
        m = GEM_TX_RE.match(ln.strip())
        if not m:
            continue
        credit = m.group(5) == "("
        amt = money(m.group(6))
        loc = ""
        if i + 1 < len(lines) and " USA" in lines[i + 1]:
            loc = re.sub(r"\s+", " ", lines[i + 1].strip())
        t = tx(iso_mdy(m.group(2)), m.group(4), amt if credit else -amt,
               cat="Payment" if credit else None, payee="Card payment" if credit else None,
               postDate=iso_mdy(m.group(3)), ref=m.group(1), location=loc)
        txns.append(t)
    return {"from": from_iso, "to": to_iso, "account": acct.group(1),
            "card": {"statementBalance": _f(full, r"Statement Balance \$([\d,]+\.\d{2})"),
                     "previousBalance": _f(full, r"Previous Balance \$([\d,]+\.\d{2})"),
                     "purchases": _f(full, r"Purchases \$([\d,]+\.\d{2})") or 0.0,
                     "payments": _f(full, r"Payments \(\$([\d,]+\.\d{2})\)") or 0.0,
                     "interestCharged": _f(full, r"Interest Charged \$([\d,]+\.\d{2})") or 0.0,
                     "creditLimit": _f(full, r"Credit Limit \$([\d,]+\.\d{2})"),
                     "availableCredit": _f(full, r"Available Credit \$([\d,]+\.\d{2})"),
                     "minPayment": _f(full, r"Minimum Payment Due \$([\d,]+\.\d{2})"),
                     "dueDate": iso_mdy(due.group(1)) if due else None},
            "transactions": txns}


# ── Chase Prime Visa (Cards/Amazon) ───────────────────────────────────────────
CHASE_TX_RE = re.compile(r"^(\d{2}/\d{2})\s+(.*?)\s+(-?[\d,]+\.\d{2})\s*$")


def parse_chase(path: str) -> dict | None:
    lines = read_lines(path)
    full = "\n".join(lines)
    per = re.search(r"Opening/Closing Date\s+(\d{2}/\d{2}/\d{2})\s*-\s*(\d{2}/\d{2}/\d{2})", full)
    if not per:
        return None
    from_iso, to_iso = iso_mdy(per.group(1)), iso_mdy(per.group(2))
    bal = re.findall(r"New Balance\s+\$([\d,]+\.\d{2})", full)
    txns = []
    for ln in lines:
        m = CHASE_TX_RE.match(ln.strip())
        if not m:
            continue
        val = money(m.group(3))
        if val == 0:
            continue
        txns.append(tx(iso_mmdd(m.group(1), from_iso, to_iso), m.group(2), -val))
    return {"from": from_iso, "to": to_iso, "account": "6395",
            "card": {"statementBalance": money(bal[-1]) if bal else None,
                     "previousBalance": _f(full, r"Previous Balance \$([\d,]+\.\d{2})"),
                     "purchases": _f(full, r"Purchases \+\$([\d,]+\.\d{2})") or 0.0,
                     "payments": _f(full, r"Payment, Credits -\$([\d,]+\.\d{2})") or 0.0,
                     "interestCharged": _f(full, r"Interest Charged \$([\d,]+\.\d{2})") or 0.0,
                     "creditLimit": _f(full, r"Credit Access Line \$([\d,]+)"),
                     "availableCredit": _f(full, r"Available Credit \$([\d,]+)"),
                     "minPayment": None,
                     "dueDate": iso_mdy(re.search(r"(\d{2}/\d{2}/\d{2})", full.split("Payment Due Date")[-1][:40]).group(1)) if "Payment Due Date" in full and re.search(r"(\d{2}/\d{2}/\d{2})", full.split("Payment Due Date")[-1][:40]) else None},
            "transactions": txns}


# ── Synchrony PayPal (Cards/PayPal) ───────────────────────────────────────────
SYNC_TX_RE = re.compile(r"^(\d{2}/\d{2})\s+(?:[A-Z0-9]{12,}\s+)?(.*?)\s+\$([\d,]+\.\d{2})(-?)\s*$")


def parse_synchrony(path: str) -> dict | None:
    lines = read_lines(path)
    full = "\n".join(lines)
    due = re.search(r"Payment due date\s+(\d{2}/\d{2}/\d{4})", full)
    txns = []
    for ln in lines:
        m = SYNC_TX_RE.match(ln.strip())
        if not m:
            continue
        val = money(m.group(3))
        if val == 0:
            continue
        credit = m.group(4) == "-"
        txns.append(tx(m.group(1), m.group(2), val if credit else -val,
                       cat="Payment" if credit else None, payee="Card payment" if credit else None))
    if not txns:
        return None
    dates = sorted(t["date"] for t in txns if "/" not in t["date"])
    # transaction dates are MM/DD; attach year from due date (statement year)
    yr = due.group(1)[-4:] if due else "2026"
    for t in txns:
        mm, dd = t["date"].split("/")
        t["date"] = f"{yr}-{int(mm):02d}-{int(dd):02d}"
    isos = sorted(t["date"] for t in txns)
    return {"from": isos[0], "to": isos[-1], "account": "paypal",
            "card": {"statementBalance": _f(full, r"New balance\s+\$([\d,]+\.\d{2})"),
                     "previousBalance": None,
                     "purchases": round(sum(-t["amount"] for t in txns if t["amount"] < 0), 2),
                     "payments": round(sum(t["amount"] for t in txns if t["amount"] > 0), 2),
                     "interestCharged": 0.0,
                     "creditLimit": None, "availableCredit": None,
                     "minPayment": _f(full, r"Minimum payment due\s+\$([\d,]+\.\d{2})"),
                     "dueDate": iso_mdy(due.group(1)) if due else None},
            "transactions": txns}


# ── Generic CSV card activity ─────────────────────────────────────────────────
def parse_csv_card(path: str, issuer: str) -> list[dict]:
    out = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            try:
                if issuer == "amex":
                    d, desc, amt = row["Date"], row["Description"], money(row["Amount"])
                    out.append(tx(iso_mdy(d), desc, -amt))
                elif issuer == "apple":
                    amt = money(row["Amount (USD)"])
                    raw = (row.get("Category") or "").strip()
                    # Use Apple's category unless it's generic "Other"/blank — then
                    # re-derive from the merchant so it lands in a real bucket.
                    if row.get("Type") == "Payment":
                        cat = "Payment"
                    elif raw and raw.lower() != "other":
                        cat = norm_cat(raw)
                    else:
                        cat = None
                    out.append(tx(iso_mdy(row["Transaction Date"]), row["Description"], -amt,
                                  cat=cat, payee=row.get("Merchant") or None,
                                  postDate=iso_mdy(row["Clearing Date"]) if row.get("Clearing Date") else None))
                elif issuer == "discover":
                    amt = money(row["Amount"])
                    raw = (row.get("Category") or "").strip()
                    if "Payment" in raw:
                        cat = "Payment"
                    elif raw and raw.lower() != "other":
                        cat = norm_cat(raw)
                    else:
                        cat = None
                    out.append(tx(iso_mdy(row["Trans. Date"]), row["Description"], -amt,
                                  cat=cat, postDate=iso_mdy(row["Post Date"]) if row.get("Post Date") else None))
            except (KeyError, ValueError):
                continue
    return out


# ── Account assembly ──────────────────────────────────────────────────────────
def deposit_account(acct_id, kind, name, files):
    parsed = {}
    for f in files:
        st = parse_deposit(f)
        if st:
            parsed[f"{st['from']}|{st['to']}"] = st
    if not parsed:
        return None
    s = sorted(parsed.values(), key=lambda x: x["from"])
    txns = sorted((t for x in s for t in x["transactions"]), key=lambda t: t["date"])
    daily = sorted(({"date": d["date"], "balance": d["balance"]} for x in s for d in x["dailyBalances"]), key=lambda d: d["date"])
    return {"id": acct_id, "kind": kind, "name": name, "last4": s[0]["account"][-4:],
            "periodFrom": s[0]["from"], "periodTo": s[-1]["to"], "currentBalance": s[-1]["closingBalance"],
            "transactions": txns, "dailyBalances": daily,
            "statements": [{k: x[k] for k in ("from", "to", "openingBalance", "closingBalance", "totalDeposits", "totalDebits")} for x in s]}


def card_account_pdf(acct_id, name, files, parser):
    parsed = {}
    for f in files:
        st = parser(f)
        if st:
            parsed[f"{st['from']}|{st['to']}"] = st
    if not parsed:
        return None
    s = sorted(parsed.values(), key=lambda x: x["from"])
    latest = s[-1]
    txns = sorted((t for x in s for t in x["transactions"]), key=lambda t: t["date"])
    return {"id": acct_id, "kind": "card", "name": name, "last4": str(latest["account"])[-4:],
            "periodFrom": s[0]["from"], "periodTo": latest["to"], "currentBalance": latest["card"]["statementBalance"],
            "transactions": txns, "card": latest["card"],
            "cardStatements": [{"from": x["from"], "to": x["to"], "statementBalance": x["card"]["statementBalance"],
                                "purchases": x["card"]["purchases"], "payments": x["card"]["payments"],
                                "interestCharged": x["card"]["interestCharged"]} for x in s]}


def card_account_csv(acct_id, name, files, issuer):
    seen, txns = set(), []
    for f in files:
        for t in parse_csv_card(f, issuer):
            key = (t["date"], t["description"], t["amount"])
            if key in seen:
                continue
            seen.add(key)
            txns.append(t)
    if not txns:
        return None
    txns.sort(key=lambda t: t["date"])
    return {"id": acct_id, "kind": "card", "name": name, "last4": None,
            "periodFrom": txns[0]["date"], "periodTo": txns[-1]["date"], "currentBalance": None,
            "transactions": txns}  # activity-only: no statement summary / balance


def main() -> None:
    accounts = []
    for acct_id, kind, name, rel in [("checking", "checking", "Checking", "Bank/Checking"),
                                      ("savings", "savings", "Savings", "Bank/Saving")]:
        files = sorted(glob.glob(os.path.join(PRIVATE_DIR, rel, "*.pdf")))
        acc = deposit_account(acct_id, kind, name, files) if files else None
        if acc:
            accounts.append(acc)
            print(f"[ingest] {name}: {len(acc['transactions'])} tx, balance {acc['currentBalance']}")

    # Card sources: (id, name, relative dir, kind, parser/issuer)
    pdf_cards = [("gemini", "Gemini", "Cards/Gemini", parse_gemini),
                 ("amazon", "Amazon (Chase)", "Cards/Amazon", parse_chase),
                 ("paypal", "PayPal", "Cards/PayPal", parse_synchrony)]
    for acct_id, name, rel, parser in pdf_cards:
        files = sorted(glob.glob(os.path.join(PRIVATE_DIR, rel, "*.pdf")))
        acc = card_account_pdf(acct_id, f"{name} Card", files, parser) if files else None
        if acc:
            accounts.append(acc)
            print(f"[ingest] {acc['name']}: {len(acc['transactions'])} tx, balance {acc['currentBalance']}, limit {acc['card'].get('creditLimit')}")

    csv_cards = [("amex_blue", "Amex Blue", "Cards/AMEX/Blue", "amex"),
                 ("amex_gold", "Amex Gold", "Cards/AMEX/Gold", "amex"),
                 ("apple", "Apple Card", "Cards/Apple", "apple"),
                 ("discover", "Discover", "Cards/Discover", "discover")]
    for acct_id, name, rel, issuer in csv_cards:
        files = sorted(glob.glob(os.path.join(PRIVATE_DIR, rel, "*.csv")))
        acc = card_account_csv(acct_id, name, files, issuer) if files else None
        if acc:
            accounts.append(acc)
            print(f"[ingest] {acc['name']}: {len(acc['transactions'])} tx (activity only)")

    # Manual overrides for activity-only cards (real balance/limit from the
    # issuer app, since the CSV/PDF exports don't carry it). private/Cards/overrides.json
    ov_path = os.path.join(PRIVATE_DIR, "Cards", "overrides.json")
    if os.path.exists(ov_path):
        with open(ov_path) as fh:
            overrides = json.load(fh)
        for acc in accounts:
            ov = overrides.get(acc["id"])
            if not isinstance(ov, dict):
                continue
            spend = round(sum(-t["amount"] for t in acc["transactions"] if t["amount"] < 0), 2)
            pays = round(sum(t["amount"] for t in acc["transactions"] if t["amount"] > 0), 2)
            card = acc.get("card") or {"statementBalance": None, "previousBalance": None,
                                       "purchases": spend, "payments": pays, "interestCharged": 0.0,
                                       "creditLimit": None, "availableCredit": None,
                                       "minPayment": None, "dueDate": None}
            for k in ("statementBalance", "creditLimit", "availableCredit", "minPayment", "dueDate"):
                if ov.get(k) is not None:
                    card[k] = ov[k]
            acc["card"] = card
            if card["statementBalance"] is not None:
                acc["currentBalance"] = card["statementBalance"]
            if ov.get("last4"):
                acc["last4"] = str(ov["last4"])
            print(f"[ingest] override {acc['name']}: balance {acc['currentBalance']}, limit {card.get('creditLimit')}")

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PATH, "w") as fh:
        json.dump({"accounts": accounts, "generatedAt": None}, fh, indent=2)
    print(f"[ingest] wrote {OUT_PATH}: {len(accounts)} accounts")


if __name__ == "__main__":
    main()
