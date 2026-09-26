#!/usr/bin/env python3
"""Build the "Sell on Vinted" iPhone Shortcut as an unsigned plist.

    python3 make_shortcut.py && shortcuts sign --mode anyone \
        --input Sell-on-Vinted.unsigned.shortcut --output Sell-on-Vinted.shortcut

The Mac address and the intake secret are import questions: Shortcuts asks for them
when the file is installed, so the file itself holds no secret.
"""
import plistlib
import uuid
from pathlib import Path

OUT = Path(__file__).with_name("Sell-on-Vinted.unsigned.shortcut")
OBJ = "￼"  # Shortcuts' placeholder character for an inline variable


def uid():
    return str(uuid.uuid4()).upper()


def output(action_uuid, name):
    return {"Type": "ActionOutput", "OutputUUID": action_uuid, "OutputName": name}


def var(name):
    return {"Type": "Variable", "VariableName": name}


def attachment(ref):
    return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}


def text(s, refs=()):
    """A text field. Each OBJ in s is replaced, in order, by the matching ref."""
    by_range, pos = {}, 0
    for ref in refs:
        pos = s.index(OBJ, pos)
        by_range[f"{{{pos}, 1}}"] = ref
        pos += 1
    return {"Value": {"string": s, "attachmentsByRange": by_range}, "WFSerializationType": "WFTextTokenString"}


def fields(items):
    """A dictionary-style field (form body, headers). items: (key, value, item_type)."""
    return {
        "Value": {"WFDictionaryFieldValueItems": [
            {"WFItemType": t, "WFKey": text(k), "WFValue": v} for k, v, t in items
        ]},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def action(ident, **params):
    return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": params}


host_id, secret_id, size_id, cond_list_id, cond_id, flaws_id = (uid() for _ in range(6))
loop_group, post_id, msg_id = uid(), uid(), uid()

actions = [
    # 0, 1: filled in by the import questions
    action("gettext", UUID=host_id, CustomOutputName="Mac address", WFTextActionText="Suns-MacBook-Pro.local"),
    action("gettext", UUID=secret_id, CustomOutputName="Intake secret", WFTextActionText="paste-INTAKE_SECRET-here"),
    action("ask", UUID=size_id, CustomOutputName="Size", WFInputType="Text",
           WFAskActionPrompt="Size? (from the care label)"),
    action("list", UUID=cond_list_id, WFItems=["New with tags", "New without tags", "Very good", "Good", "Satisfactory"]),
    action("choosefromlist", UUID=cond_id, CustomOutputName="Condition",
           WFInput=attachment(output(cond_list_id, "List")), WFChooseFromListActionPrompt="Condition?"),
    action("ask", UUID=flaws_id, CustomOutputName="Flaws", WFInputType="Text",
           WFAskActionPrompt="Flaws? Keep 'none' if there are none", WFAskActionDefaultAnswer="none"),
    # one pass per shared photo: JPEG without metadata (drops GPS), then 1600 px wide
    action("repeat.each", GroupingIdentifier=loop_group, WFControlFlowMode=0,
           WFInput=attachment({"Type": "ExtensionInput"})),
    action("image.convert", UUID=(conv := uid()), WFImageFormat="JPEG", WFImagePreserveMetadata=False,
           WFImageCompressionQuality=0.85, WFInput=attachment(var("Repeat Item"))),
    action("image.resize", UUID=(res := uid()), WFImageResizeWidth="1600",
           WFImage=attachment(output(conv, "Converted Image"))),
    # base64 text, one photo per line: Shortcuts drops file-typed form fields from imported
    # files, so the photos travel in a text field instead (the intake decodes them)
    action("base64encode", UUID=(b64 := uid()), WFEncodeMode="Encode", WFBase64LineBreakMode="None",
           WFInput=attachment(output(res, "Resized Image"))),
    action("appendvariable", WFVariableName="Photos", WFInput=attachment(output(b64, "Base64 Encoded"))),
    action("repeat.each", GroupingIdentifier=loop_group, WFControlFlowMode=2),
    action("downloadurl", UUID=post_id, CustomOutputName="Intake reply",
           WFURL=text(f"http://{OBJ}:4646/intake", [output(host_id, "Text")]),
           WFHTTPMethod="POST", WFHTTPBodyType="Form", ShowHeaders=True,
           WFHTTPHeaders=fields([("X-SecondLife-Secret", text(OBJ, [output(secret_id, "Text")]), 0)]),
           WFFormValues=fields([
               ("photos_b64", text(OBJ, [var("Photos")]), 0),
               ("size", text(OBJ, [output(size_id, "Provided Input")]), 0),
               ("condition", text(OBJ, [output(cond_id, "Chosen Item")]), 0),
               ("flaws", text(OBJ, [output(flaws_id, "Provided Input")]), 0),
           ])),
    action("getvalueforkey", UUID=msg_id, WFGetDictionaryValueType="Value", WFDictionaryKey="message",
           WFInput=attachment(output(post_id, "Intake reply"))),
    action("notification", WFNotificationActionTitle="Sell on Vinted",
           WFNotificationActionBody=text(OBJ, [output(msg_id, "Dictionary Value")])),
]

workflow = {
    "WFWorkflowName": "Sell on Vinted",
    "WFWorkflowClientVersion": "2605.0.5",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 61440},
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowInputContentItemClasses": ["WFImageContentItem"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowOutputContentItemClasses": [],
    "WFQuickActionSurfaces": [],
    "WFWorkflowActions": actions,
    "WFWorkflowImportQuestions": [
        {"ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText",
         "DefaultValue": "Suns-MacBook-Pro.local",
         "Text": "Mac address: its Tailscale name (works anywhere) or Suns-MacBook-Pro.local (same Wi-Fi only)"},
        {"ActionIndex": 1, "Category": "Parameter", "ParameterKey": "WFTextActionText", "DefaultValue": "",
         "Text": "Intake secret: run  grep INTAKE_SECRET ~/SecondLife/agent/.env  on the Mac and paste the value"},
    ],
}

with OUT.open("wb") as f:
    plistlib.dump(workflow, f, fmt=plistlib.FMT_BINARY)
print(f"wrote {OUT}")
