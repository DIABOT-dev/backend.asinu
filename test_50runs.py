#!/usr/bin/env python3
"""50-test runner for triage-chat API"""
import json
import requests
import sys
import time

URL = "http://localhost:3000/api/test/triage-chat"
TIMEOUT = 30

PROFILE_A = {"birth_year":1958,"gender":"Nam","full_name":"Tran Van Hung","medical_conditions":["Tieu duong","Cao huyet ap","Tim mach"]}
PROFILE_B = {"birth_year":1981,"gender":"Nu","full_name":"Le Thi Huong","medical_conditions":["Cao huyet ap"]}
PROFILE_C = {"birth_year":2004,"gender":"Nam","full_name":"Nguyen Minh Tuan","medical_conditions":[]}
PROFILE_D = {"birth_year":1965,"gender":"Nu","full_name":"Nguyen Thi Mai","medical_conditions":["Tieu duong","Cao huyet ap"]}

def send_msg(message, history, profile, simulated_hour=None, previous_session_summary=None):
    """Send a message to the triage-chat API and return the response."""
    payload = {
        "message": message,
        "conversation_history": history,
        "patient_profile": profile
    }
    if simulated_hour is not None:
        payload["simulatedHour"] = simulated_hour
    if previous_session_summary is not None:
        payload["previousSessionSummary"] = previous_session_summary

    try:
        r = requests.post(URL, json=payload, timeout=TIMEOUT)
        return r.json()
    except Exception as e:
        return {"error": str(e), "reply": f"ERROR: {e}", "isDone": False}

def add_history(history, role, content):
    """Add an entry to conversation history."""
    return history + [{"role": role, "content": content}]

def multi_turn(messages, profile, simulated_hour=None, previous_session_summary=None):
    """Run a multi-turn conversation. messages is a list of user messages.
    Returns (history, responses_list, turn_count)."""
    history = []
    responses = []
    for msg in messages:
        resp = send_msg(msg, history, profile, simulated_hour, previous_session_summary)
        responses.append(resp)
        history = add_history(history, "user", msg)
        reply = resp.get("reply", "")
        history = add_history(history, "assistant", reply)
        if resp.get("isDone"):
            break
    return history, responses, len(responses)

def full_checkin(greeting, symptom_msg, profile, extra_responses=None):
    """Run a full check-in: greeting -> symptom -> answer follow-ups until isDone.
    extra_responses are canned answers for follow-up questions."""
    if extra_responses is None:
        extra_responses = [
            "Hom nay moi bi",
            "Van nhu vay, khong thay do",
            "Chua lam gi ca",
            "Da, cam on bac si",
            "Vang",
            "Khong co gi khac",
        ]

    history = []
    responses = []

    # Greeting
    resp = send_msg(greeting, history, profile)
    responses.append(resp)
    history = add_history(history, "user", greeting)
    history = add_history(history, "assistant", resp.get("reply", ""))

    # Symptom
    resp = send_msg(symptom_msg, history, profile)
    responses.append(resp)
    history = add_history(history, "user", symptom_msg)
    history = add_history(history, "assistant", resp.get("reply", ""))

    # Follow-ups until isDone or max 6 extra turns
    idx = 0
    while not resp.get("isDone") and idx < len(extra_responses):
        msg = extra_responses[idx]
        resp = send_msg(msg, history, profile)
        responses.append(resp)
        history = add_history(history, "user", msg)
        history = add_history(history, "assistant", resp.get("reply", ""))
        idx += 1

    return history, responses

def get_last_done_response(responses):
    """Get the last response that has isDone or the very last one."""
    for r in reversed(responses):
        if r.get("isDone"):
            return r
    return responses[-1] if responses else {}

# ============================================================
# SCENARIO A: "On" -> FU -> "On" -> END
# ============================================================
def run_scenario_a():
    print("=" * 70)
    print("SCENARIO A: 'On' -> FU toi -> 'On' -> END (10 runs, PROFILE_A)")
    print("=" * 70)

    on_variants = ["Toi on", "Khoe", "Binh thuong", "ok", "on", "Tot", "Khoe re", "Binh thuong thoi", "Toi khoe", "Van on"]
    results = []

    for i, variant in enumerate(on_variants):
        run_num = i + 1
        print(f"\n--- Run A{run_num}: '{variant}' ---")

        # Step 1: Greeting
        history = []
        resp1 = send_msg("Chao bac si", history, PROFILE_A)
        history = add_history(history, "user", "Chao bac si")
        history = add_history(history, "assistant", resp1.get("reply", ""))

        # Step 2: "Toi on" variant
        resp2 = send_msg(variant, history, PROFILE_A)
        history = add_history(history, "user", variant)
        history = add_history(history, "assistant", resp2.get("reply", ""))

        isDone = resp2.get("isDone", False)
        severity = resp2.get("severity", "N/A")
        summary = resp2.get("sessionSummary", resp2.get("reply", "")[:80])

        # Step 3: Follow-up (simulated hour=21, with previousSessionSummary)
        fu_history = []
        fu_resp1 = send_msg("Chao bac si", fu_history, PROFILE_A,
                           simulated_hour=21,
                           previous_session_summary=summary)
        fu_history = add_history(fu_history, "user", "Chao bac si")
        fu_history = add_history(fu_history, "assistant", fu_resp1.get("reply", ""))

        # Step 4: "Van on"
        fu_resp2 = send_msg("Van on", fu_history, PROFILE_A,
                           simulated_hour=21,
                           previous_session_summary=summary)

        fu_reply = fu_resp1.get("reply", "") + " " + fu_resp2.get("reply", "")
        fu_isDone = fu_resp2.get("isDone", False)
        fu_severity = fu_resp2.get("severity", "N/A")

        has_sleep = any(w in fu_reply.lower() for w in ["ngu", "ngủ", "ngon", "sang", "sáng"])

        passed = (isDone == True and
                 severity == "low" and
                 fu_isDone == True and
                 has_sleep)

        result = {
            "run": run_num,
            "variant": variant,
            "isDone": isDone,
            "severity": severity,
            "fu_isDone": fu_isDone,
            "fu_severity": fu_severity,
            "has_sleep_ref": has_sleep,
            "PASS": passed
        }
        results.append(result)
        status = "PASS" if passed else "FAIL"
        print(f"  isDone={isDone}, severity={severity}, FU_isDone={fu_isDone}, FU_sev={fu_severity}, sleep_ref={has_sleep} => {status}")
        if not passed:
            print(f"  Reply2: {resp2.get('reply','')[:100]}")
            print(f"  FU reply: {fu_reply[:120]}")

    return results

# ============================================================
# SCENARIO B: Hoi met -> FU do -> END
# ============================================================
def run_scenario_b():
    print("\n" + "=" * 70)
    print("SCENARIO B: Hoi met -> symptoms -> FU -> 'do roi' -> END (10 runs, PROFILE_A)")
    print("=" * 70)

    symptoms = [
        "Hoi met va dau dau",
        "Hoi met, moi vai",
        "Hoi met va chong mat",
        "Hoi met, dau bung",
        "Hoi met va te tay",
        "Hoi met, dau lung",
        "Hoi met va buon non",
        "Hoi met, dau khop",
        "Hoi met moi",
        "Hoi met va kho chiu"
    ]

    extra_answers = [
        "Hom nay moi bi",
        "Van nhu vay, khong thay do",
        "Chua lam gi ca",
        "Da vang",
        "Khong co gi khac",
        "Da, cam on"
    ]

    results = []

    for i, symptom in enumerate(symptoms):
        run_num = i + 1
        print(f"\n--- Run B{run_num}: '{symptom}' ---")

        history, responses = full_checkin("Chao bac si", symptom, PROFILE_A, extra_answers)

        final = get_last_done_response(responses)
        turn_count = len(responses)
        severity = final.get("severity", "N/A")
        summary = final.get("sessionSummary", final.get("reply", "")[:80])
        isDone = final.get("isDone", False)

        # Follow-up
        fu_history = []
        fu_resp1 = send_msg("Chao bac si", fu_history, PROFILE_A,
                           simulated_hour=15,
                           previous_session_summary=summary)
        fu_history = add_history(fu_history, "user", "Chao bac si")
        fu_history = add_history(fu_history, "assistant", fu_resp1.get("reply", ""))

        fu_resp2 = send_msg("Do roi, het met roi", fu_history, PROFILE_A,
                           simulated_hour=15,
                           previous_session_summary=summary)
        fu_history = add_history(fu_history, "user", "Do roi, het met roi")
        fu_history = add_history(fu_history, "assistant", fu_resp2.get("reply", ""))

        fu_turns = 2
        fu_isDone = fu_resp2.get("isDone", False)
        if not fu_isDone:
            fu_resp3 = send_msg("Da, het roi", fu_history, PROFILE_A,
                               simulated_hour=15,
                               previous_session_summary=summary)
            fu_isDone = fu_resp3.get("isDone", False)
            fu_turns = 3
            fu_severity = fu_resp3.get("severity", fu_resp2.get("severity", "N/A"))
        else:
            fu_severity = fu_resp2.get("severity", "N/A")

        checkin_ok = turn_count <= 8
        severity_ok = severity in ("medium", "high", "critical")
        fu_turns_ok = fu_turns <= 2
        fu_severity_ok = fu_severity == "low"

        passed = checkin_ok and severity_ok and fu_turns_ok and fu_severity_ok

        result = {
            "run": run_num,
            "symptom": symptom,
            "turns": turn_count,
            "isDone": isDone,
            "severity": severity,
            "fu_turns": fu_turns,
            "fu_isDone": fu_isDone,
            "fu_severity": fu_severity,
            "PASS": passed
        }
        results.append(result)
        status = "PASS" if passed else "FAIL"
        fail_reasons = []
        if not checkin_ok: fail_reasons.append(f"turns={turn_count}>8")
        if not severity_ok: fail_reasons.append(f"severity={severity}!=medium")
        if not fu_turns_ok: fail_reasons.append(f"fu_turns={fu_turns}>2")
        if not fu_severity_ok: fail_reasons.append(f"fu_sev={fu_severity}!=low")
        extra = f" ({', '.join(fail_reasons)})" if fail_reasons else ""
        print(f"  turns={turn_count}, sev={severity}, fu_turns={fu_turns}, fu_sev={fu_severity} => {status}{extra}")

    return results

# ============================================================
# SCENARIO C: Hoi met -> FU1 "van vay" -> FU2 "do roi" -> END
# ============================================================
def run_scenario_c():
    print("\n" + "=" * 70)
    print("SCENARIO C: Hoi met -> FU1 'van vay' -> FU2 'do roi' (10 runs, rotate profiles)")
    print("=" * 70)

    profile_map = {
        1: PROFILE_A, 2: PROFILE_A, 3: PROFILE_A,
        4: PROFILE_B, 5: PROFILE_B, 6: PROFILE_B,
        7: PROFILE_C, 8: PROFILE_C,
        9: PROFILE_D, 10: PROFILE_D
    }
    expected_xungho = {
        1: "chu", 2: "chu", 3: "chu",
        4: "chi", 5: "chi", 6: "chi",
        7: "ban", 8: "ban",
        9: "co", 10: "co"
    }
    profile_names = {
        1: "A", 2: "A", 3: "A",
        4: "B", 5: "B", 6: "B",
        7: "C", 8: "C",
        9: "D", 10: "D"
    }
    has_conditions = {
        1: True, 2: True, 3: True,
        4: True, 5: True, 6: True,
        7: False, 8: False,
        9: True, 10: True
    }

    symptoms_list = [
        "Hoi met va dau dau", "Hoi met, chong mat", "Hoi met va moi vai",
        "Hoi met, dau lung", "Hoi met va kho chiu", "Hoi met, dau bung",
        "Hoi met va moi", "Hoi met, nhuc dau", "Hoi met va dau khop", "Hoi met, te tay"
    ]

    extra_answers = [
        "Hom nay moi bi",
        "Van nhu vay",
        "Chua lam gi ca",
        "Da vang",
        "Khong co gi khac",
        "Da, cam on"
    ]

    results = []

    for i in range(10):
        run_num = i + 1
        profile = profile_map[run_num]
        pname = profile_names[run_num]
        xungho = expected_xungho[run_num]
        symptom = symptoms_list[i]

        print(f"\n--- Run C{run_num}: Profile {pname}, '{symptom}', expect xungho='{xungho}' ---")

        # Full check-in
        history, responses = full_checkin("Chao bac si", symptom, profile, extra_answers)
        final = get_last_done_response(responses)
        checkin_severity = final.get("severity", "N/A")
        summary = final.get("sessionSummary", final.get("reply", "")[:80])
        checkin_hour = 10  # assume morning check-in

        # FU1: +3h => hour 13
        fu1_history = []
        fu1_resp1 = send_msg("Chao bac si", fu1_history, profile,
                            simulated_hour=13,
                            previous_session_summary=summary)
        fu1_history = add_history(fu1_history, "user", "Chao bac si")
        fu1_history = add_history(fu1_history, "assistant", fu1_resp1.get("reply", ""))

        fu1_resp2 = send_msg("Van vay, chua do", fu1_history, profile,
                            simulated_hour=13,
                            previous_session_summary=summary)
        fu1_history = add_history(fu1_history, "user", "Van vay, chua do")
        fu1_history = add_history(fu1_history, "assistant", fu1_resp2.get("reply", ""))

        fu1_turns = 2
        fu1_isDone = fu1_resp2.get("isDone", False)
        if not fu1_isDone:
            fu1_resp3 = send_msg("Da, van nhu vay", fu1_history, profile,
                                simulated_hour=13,
                                previous_session_summary=summary)
            fu1_isDone = fu1_resp3.get("isDone", False)
            fu1_turns = 3
            fu1_final = fu1_resp3 if fu1_isDone else fu1_resp2
        else:
            fu1_final = fu1_resp2

        fu1_severity = fu1_final.get("severity", "N/A")
        fu1_summary = fu1_final.get("sessionSummary", fu1_final.get("reply", "")[:80])

        # Collect all replies for xungho check
        all_replies = " ".join([r.get("reply", "") for r in responses])
        all_replies += " " + fu1_resp1.get("reply", "") + " " + fu1_resp2.get("reply", "")

        # FU2: +3h => hour 16
        fu2_history = []
        fu2_resp1 = send_msg("Chao bac si", fu2_history, profile,
                            simulated_hour=16,
                            previous_session_summary=fu1_summary or summary)
        fu2_history = add_history(fu2_history, "user", "Chao bac si")
        fu2_history = add_history(fu2_history, "assistant", fu2_resp1.get("reply", ""))

        fu2_resp2 = send_msg("Do roi, het met roi", fu2_history, profile,
                            simulated_hour=16,
                            previous_session_summary=fu1_summary or summary)

        fu2_isDone = fu2_resp2.get("isDone", False)
        fu2_severity = fu2_resp2.get("severity", "N/A")

        all_replies += " " + fu2_resp1.get("reply", "") + " " + fu2_resp2.get("reply", "")

        # Check xungho
        xungho_found = xungho.lower() in all_replies.lower()

        # Check pass criteria
        fu1_turns_ok = fu1_turns <= 2
        if has_conditions[run_num]:
            fu1_sev_ok = fu1_severity in ("medium", "high", "critical")
        else:
            fu1_sev_ok = True  # can be low for C
        fu2_sev_ok = fu2_severity == "low"

        passed = fu1_turns_ok and fu1_sev_ok and fu2_sev_ok and xungho_found

        result = {
            "run": run_num,
            "profile": pname,
            "symptom": symptom,
            "checkin_sev": checkin_severity,
            "fu1_turns": fu1_turns,
            "fu1_severity": fu1_severity,
            "fu2_severity": fu2_severity,
            "xungho_expected": xungho,
            "xungho_found": xungho_found,
            "PASS": passed
        }
        results.append(result)
        status = "PASS" if passed else "FAIL"
        fail_reasons = []
        if not fu1_turns_ok: fail_reasons.append(f"fu1_turns={fu1_turns}>2")
        if not fu1_sev_ok: fail_reasons.append(f"fu1_sev={fu1_severity}")
        if not fu2_sev_ok: fail_reasons.append(f"fu2_sev={fu2_severity}!=low")
        if not xungho_found: fail_reasons.append(f"xungho '{xungho}' not found")
        extra = f" ({', '.join(fail_reasons)})" if fail_reasons else ""
        print(f"  checkin_sev={checkin_severity}, fu1_turns={fu1_turns}, fu1_sev={fu1_severity}, fu2_sev={fu2_severity}, xungho={xungho_found} => {status}{extra}")

    return results

# ============================================================
# SCENARIO D: Rat met -> FU nang hon
# ============================================================
def run_scenario_d():
    print("\n" + "=" * 70)
    print("SCENARIO D: Rat met -> FU 'nang hon' (10 runs, PROFILE_A)")
    print("=" * 70)

    symptoms = [
        "Rat met va dau dau nhieu",
        "Rat met, chong mat liem",
        "Rat met va kho tho",
        "Rat met, dau nguc",
        "Rat met va buon non nhieu",
        "Rat met, toan than dau nhuc",
        "Rat met va run tay chan",
        "Rat met, mat mo, chong mat",
        "Rat met va dau bung du doi",
        "Rat met, tim dap nhanh"
    ]

    extra_answers = [
        "Tu sang den gio",
        "Nang hon",
        "Chua lam gi ca",
        "Da vang, rat kho chiu",
        "Khong co gi khac",
        "Da"
    ]

    results = []

    for i, symptom in enumerate(symptoms):
        run_num = i + 1
        print(f"\n--- Run D{run_num}: '{symptom}' ---")

        history, responses = full_checkin("Chao bac si", symptom, PROFILE_A, extra_answers)
        final = get_last_done_response(responses)
        checkin_severity = final.get("severity", "N/A")
        checkin_turns = len(responses)
        summary = final.get("sessionSummary", final.get("reply", "")[:80])
        is_emergency = checkin_severity == "critical"
        familyAlert_checkin = final.get("familyAlert", False)

        # FU: +1h => hour 11
        fu_history = []
        fu_resp1 = send_msg("Chao bac si", fu_history, PROFILE_A,
                           simulated_hour=11,
                           previous_session_summary=summary)
        fu_history = add_history(fu_history, "user", "Chao bac si")
        fu_history = add_history(fu_history, "assistant", fu_resp1.get("reply", ""))

        fu_resp2 = send_msg("Nang hon nhieu, rat kho chiu", fu_history, PROFILE_A,
                           simulated_hour=11,
                           previous_session_summary=summary)
        fu_history = add_history(fu_history, "user", "Nang hon nhieu, rat kho chiu")
        fu_history = add_history(fu_history, "assistant", fu_resp2.get("reply", ""))

        fu_isDone = fu_resp2.get("isDone", False)
        fu_severity = fu_resp2.get("severity", "N/A")
        fu_familyAlert = fu_resp2.get("familyAlert", False)

        if not fu_isDone:
            fu_resp3 = send_msg("Van nang hon, rat lo", fu_history, PROFILE_A,
                               simulated_hour=11,
                               previous_session_summary=summary)
            fu_severity = fu_resp3.get("severity", fu_severity)
            fu_familyAlert = fu_resp3.get("familyAlert", fu_familyAlert)

        checkin_sev_ok = checkin_severity in ("high", "critical")
        fu_sev_ok = fu_severity in ("high", "critical")
        family_ok = fu_familyAlert == True or familyAlert_checkin == True

        passed = checkin_sev_ok and fu_sev_ok and family_ok

        result = {
            "run": run_num,
            "symptom": symptom,
            "checkin_turns": checkin_turns,
            "checkin_severity": checkin_severity,
            "is_emergency": is_emergency,
            "fu_severity": fu_severity,
            "familyAlert": fu_familyAlert or familyAlert_checkin,
            "PASS": passed
        }
        results.append(result)
        status = "PASS" if passed else "FAIL"
        fail_reasons = []
        if not checkin_sev_ok: fail_reasons.append(f"checkin_sev={checkin_severity}")
        if not fu_sev_ok: fail_reasons.append(f"fu_sev={fu_severity}")
        if not family_ok: fail_reasons.append("no familyAlert")
        extra = f" ({', '.join(fail_reasons)})" if fail_reasons else ""
        print(f"  checkin_sev={checkin_severity}, emergency={is_emergency}, fu_sev={fu_severity}, familyAlert={fu_familyAlert or familyAlert_checkin} => {status}{extra}")

    return results

# ============================================================
# SCENARIO E: Emergency
# ============================================================
def run_scenario_e():
    print("\n" + "=" * 70)
    print("SCENARIO E: Emergency (10 runs, PROFILE_A)")
    print("=" * 70)

    cases = [
        {"msg": "dau nguc, kho tho, va mo hoi", "expect_critical": True, "label": "MI"},
        {"msg": "yeu nua nguoi, noi kho", "expect_critical": True, "label": "Stroke"},
        {"msg": "te nua nguoi, meo mieng", "expect_critical": True, "label": "Stroke2"},
        {"msg": "sot cao, dau dau du doi, co cung", "expect_critical": True, "label": "Meningitis"},
        {"msg": "dau nguc, kho tho, va mo hoi lanh", "expect_critical": True, "label": "MI-noDiacritics"},
        {"msg": "te nua nguoi, noi ngong", "expect_critical": True, "label": "Stroke-noDiacritics"},
        {"msg": "Toi on, khong dau nguc, khong kho tho", "expect_critical": False, "label": "Negation1"},
        {"msg": "khoe, khong te tay", "expect_critical": False, "label": "Negation2"},
        {"msg": "bi co giat", "expect_critical": True, "label": "Seizure"},
        {"msg": "khat nuoc nhieu, buon non, tho nhanh", "expect_critical": True, "label": "DKA"},
    ]

    results = []

    for i, case in enumerate(cases):
        run_num = i + 1
        print(f"\n--- Run E{run_num}: {case['label']} - '{case['msg']}' ---")

        # Greeting
        history = []
        resp1 = send_msg("Chao bac si", history, PROFILE_A)
        history = add_history(history, "user", "Chao bac si")
        history = add_history(history, "assistant", resp1.get("reply", ""))

        # Symptom message
        resp2 = send_msg(case["msg"], history, PROFILE_A)
        history = add_history(history, "user", case["msg"])
        history = add_history(history, "assistant", resp2.get("reply", ""))

        severity = resp2.get("severity", "N/A")
        isDone = resp2.get("isDone", False)
        hasRedFlag = resp2.get("hasRedFlag", False)
        reply = resp2.get("reply", "")
        has_115 = "115" in reply
        familyAlert = resp2.get("familyAlert", False)

        # If not done yet, may need one more turn
        if not isDone and case["expect_critical"]:
            resp3 = send_msg("Vang, dung vay", history, PROFILE_A)
            history = add_history(history, "user", "Vang, dung vay")
            history = add_history(history, "assistant", resp3.get("reply", ""))
            severity = resp3.get("severity", severity)
            isDone = resp3.get("isDone", isDone)
            hasRedFlag = resp3.get("hasRedFlag", hasRedFlag)
            reply += " " + resp3.get("reply", "")
            has_115 = "115" in reply
            familyAlert = resp3.get("familyAlert", familyAlert)

        if case["expect_critical"]:
            passed = (severity == "critical" and hasRedFlag == True and has_115)
        else:
            passed = (severity == "low" and hasRedFlag == False)

        result = {
            "run": run_num,
            "label": case["label"],
            "msg": case["msg"],
            "severity": severity,
            "isDone": isDone,
            "hasRedFlag": hasRedFlag,
            "has_115": has_115,
            "familyAlert": familyAlert,
            "expect_critical": case["expect_critical"],
            "PASS": passed
        }
        results.append(result)
        status = "PASS" if passed else "FAIL"

        if case["expect_critical"]:
            fail_reasons = []
            if severity != "critical": fail_reasons.append(f"sev={severity}!=critical")
            if not hasRedFlag: fail_reasons.append("no redFlag")
            if not has_115: fail_reasons.append("no 115")
        else:
            fail_reasons = []
            if severity != "low": fail_reasons.append(f"sev={severity}!=low")
            if hasRedFlag: fail_reasons.append("has redFlag (shouldn't)")

        extra = f" ({', '.join(fail_reasons)})" if fail_reasons else ""
        print(f"  severity={severity}, hasRedFlag={hasRedFlag}, 115={has_115}, familyAlert={familyAlert} => {status}{extra}")

    return results

# ============================================================
# MAIN
# ============================================================
if __name__ == "__main__":
    print("=" * 70)
    print("TRIAGE-CHAT 50-TEST RUNNER")
    print("=" * 70)

    all_results = {}

    all_results["A"] = run_scenario_a()
    all_results["B"] = run_scenario_b()
    all_results["C"] = run_scenario_c()
    all_results["D"] = run_scenario_d()
    all_results["E"] = run_scenario_e()

    # Print summary tables
    print("\n\n" + "=" * 70)
    print("DETAILED RESULTS TABLES")
    print("=" * 70)

    # Table A
    print("\n--- TABLE A: 'On' -> FU -> 'On' -> END ---")
    print(f"{'Run':<5} {'Variant':<20} {'isDone':<8} {'Severity':<10} {'FU_isDone':<10} {'FU_Sev':<10} {'Sleep':<7} {'Result':<6}")
    print("-" * 76)
    for r in all_results["A"]:
        print(f"{r['run']:<5} {r['variant']:<20} {str(r['isDone']):<8} {r['severity']:<10} {str(r['fu_isDone']):<10} {r['fu_severity']:<10} {str(r['has_sleep_ref']):<7} {'PASS' if r['PASS'] else 'FAIL':<6}")
    a_pass = sum(1 for r in all_results["A"] if r["PASS"])
    print(f"Scenario A: {a_pass}/10 PASS")

    # Table B
    print("\n--- TABLE B: Hoi met -> FU 'do roi' -> END ---")
    print(f"{'Run':<5} {'Symptom':<25} {'Turns':<7} {'Severity':<10} {'FU_Turns':<10} {'FU_Sev':<10} {'Result':<6}")
    print("-" * 73)
    for r in all_results["B"]:
        print(f"{r['run']:<5} {r['symptom']:<25} {r['turns']:<7} {r['severity']:<10} {r['fu_turns']:<10} {r['fu_severity']:<10} {'PASS' if r['PASS'] else 'FAIL':<6}")
    b_pass = sum(1 for r in all_results["B"] if r["PASS"])
    print(f"Scenario B: {b_pass}/10 PASS")

    # Table C
    print("\n--- TABLE C: Hoi met -> FU1 'van vay' -> FU2 'do roi' ---")
    print(f"{'Run':<5} {'Prof':<5} {'Checkin':<10} {'FU1_T':<7} {'FU1_Sev':<10} {'FU2_Sev':<10} {'Xungho':<8} {'Found':<7} {'Result':<6}")
    print("-" * 68)
    for r in all_results["C"]:
        print(f"{r['run']:<5} {r['profile']:<5} {r['checkin_sev']:<10} {r['fu1_turns']:<7} {r['fu1_severity']:<10} {r['fu2_severity']:<10} {r['xungho_expected']:<8} {str(r['xungho_found']):<7} {'PASS' if r['PASS'] else 'FAIL':<6}")
    c_pass = sum(1 for r in all_results["C"] if r["PASS"])
    print(f"Scenario C: {c_pass}/10 PASS")

    # Table D
    print("\n--- TABLE D: Rat met -> FU 'nang hon' ---")
    print(f"{'Run':<5} {'Symptom':<30} {'CI_Turns':<10} {'CI_Sev':<10} {'Emerg':<7} {'FU_Sev':<10} {'FamAlert':<10} {'Result':<6}")
    print("-" * 88)
    for r in all_results["D"]:
        print(f"{r['run']:<5} {r['symptom']:<30} {r['checkin_turns']:<10} {r['checkin_severity']:<10} {str(r['is_emergency']):<7} {r['fu_severity']:<10} {str(r['familyAlert']):<10} {'PASS' if r['PASS'] else 'FAIL':<6}")
    d_pass = sum(1 for r in all_results["D"] if r["PASS"])
    print(f"Scenario D: {d_pass}/10 PASS")

    # Table E
    print("\n--- TABLE E: Emergency ---")
    print(f"{'Run':<5} {'Label':<22} {'Severity':<10} {'RedFlag':<9} {'115':<5} {'FamAlert':<10} {'ExpCrit':<9} {'Result':<6}")
    print("-" * 76)
    for r in all_results["E"]:
        print(f"{r['run']:<5} {r['label']:<22} {r['severity']:<10} {str(r['hasRedFlag']):<9} {str(r['has_115']):<5} {str(r['familyAlert']):<10} {str(r['expect_critical']):<9} {'PASS' if r['PASS'] else 'FAIL':<6}")
    e_pass = sum(1 for r in all_results["E"] if r["PASS"])
    print(f"Scenario E: {e_pass}/10 PASS")

    # Final summary
    total = a_pass + b_pass + c_pass + d_pass + e_pass
    print("\n" + "=" * 70)
    print(f"FINAL SUMMARY: {total}/50 PASS")
    print(f"  Scenario A: {a_pass}/10")
    print(f"  Scenario B: {b_pass}/10")
    print(f"  Scenario C: {c_pass}/10")
    print(f"  Scenario D: {d_pass}/10")
    print(f"  Scenario E: {e_pass}/10")
    print("=" * 70)
