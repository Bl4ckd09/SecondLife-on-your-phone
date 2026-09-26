#!/usr/bin/env python3
"""Build the unsigned "Sell with Grok" iPhone Shortcut."""
import plistlib
import uuid
from pathlib import Path

OUT = Path(__file__).with_name("Sell-with-Grok.unsigned.shortcut")
OBJ = "￼"


def uid():
    return str(uuid.uuid4()).upper()


def output(action_uuid, name):
    return {"Type": "ActionOutput", "OutputUUID": action_uuid, "OutputName": name}


def var(name):
    return {"Type": "Variable", "VariableName": name}


def attachment(ref):
    return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}


def text(value, refs=()):
    by_range, pos = {}, 0
    for ref in refs:
        pos = value.index(OBJ, pos)
        by_range[f"{{{pos}, 1}}"] = ref
        pos += 1
    return {"Value": {"string": value, "attachmentsByRange": by_range}, "WFSerializationType": "WFTextTokenString"}


def fields(items):
    return {
        "Value": {"WFDictionaryFieldValueItems": [
            {"WFItemType": item_type, "WFKey": text(key), "WFValue": value}
            for key, value, item_type in items
        ]},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def action(ident, **params):
    return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": params}


url_id, key_id, pick_id, size_id, conditions_id, condition_id, flaws_id, date_id, item_id = (uid() for _ in range(9))
input_group, photo_group = uid(), uid()

headers = lambda content_type: fields([
    ("apikey", text(OBJ, [output(key_id, "Text")]), 0),
    ("Authorization", text(f"Bearer {OBJ}", [output(key_id, "Text")]), 0),
    ("Content-Type", text(content_type), 0),
])

actions = [
    action("gettext", UUID=url_id, CustomOutputName="Supabase project URL", WFTextActionText="https://PROJECT.supabase.co"),
    action("gettext", UUID=key_id, CustomOutputName="Supabase anon key", WFTextActionText="paste-anon-key-here"),
    action("conditional", GroupingIdentifier=input_group, WFControlFlowMode=0, WFCondition=99,
           WFInput=attachment({"Type": "ExtensionInput"})),
    action("setvariable", WFVariableName="Photos", WFInput=attachment({"Type": "ExtensionInput"})),
    action("conditional", GroupingIdentifier=input_group, WFControlFlowMode=1),
    action("selectphoto", UUID=pick_id, WFSelectPhotosActionSelectMultiple=True),
    action("setvariable", WFVariableName="Photos", WFInput=attachment(output(pick_id, "Photos"))),
    action("conditional", GroupingIdentifier=input_group, WFControlFlowMode=2),
    action("ask", UUID=size_id, CustomOutputName="Size", WFInputType="Text", WFAskActionPrompt="Size?"),
    action("list", UUID=conditions_id, WFItems=["New with tags", "New without tags", "Very good", "Good", "Satisfactory"]),
    action("choosefromlist", UUID=condition_id, CustomOutputName="Condition",
           WFInput=attachment(output(conditions_id, "List")), WFChooseFromListActionPrompt="Condition?"),
    action("ask", UUID=flaws_id, CustomOutputName="Flaws", WFInputType="Text",
           WFAskActionPrompt="Flaws? Keep 'none' if there are none", WFAskActionDefaultAnswer="none"),
    action("date", UUID=date_id, WFDateActionMode="Current Date"),
    action("format.date", UUID=item_id, CustomOutputName="Item ID", WFDateFormatStyle="Custom", WFDateFormat="yyyyMMdd-HHmmss",
           WFDate=text(OBJ, [output(date_id, "Date")])),
    action("repeat.each", GroupingIdentifier=photo_group, WFControlFlowMode=0, WFInput=attachment(var("Photos"))),
    action("image.convert", UUID=(converted_id := uid()), WFImageFormat="JPEG", WFImagePreserveMetadata=False,
           WFInput=attachment(var("Repeat Item"))),
    action("gettext", UUID=(path_id := uid()), CustomOutputName="Photo path",
           WFTextActionText=text(f"{OBJ}/photo-{OBJ}.jpg", [output(item_id, "Formatted Date"), var("Repeat Index")])),
    action("appendvariable", WFVariableName="Photo Paths", WFInput=attachment(output(path_id, "Text"))),
    action("downloadurl", WFURL=text(f"{OBJ}/storage/v1/object/intake/{OBJ}", [output(url_id, "Text"), output(path_id, "Text")]),
           WFHTTPMethod="POST", WFHTTPBodyType="File", ShowHeaders=True, WFHTTPHeaders=headers("image/jpeg"),
           WFRequestVariable=attachment(output(converted_id, "Converted Image"))),
    action("repeat.each", GroupingIdentifier=photo_group, WFControlFlowMode=2),
    action("downloadurl", WFURL=text(f"{OBJ}/rest/v1/grok_items", [output(url_id, "Text")]),
           WFHTTPMethod="POST", WFHTTPBodyType="JSON", ShowHeaders=True,
           WFHTTPHeaders=fields([
               ("apikey", text(OBJ, [output(key_id, "Text")]), 0),
               ("Authorization", text(f"Bearer {OBJ}", [output(key_id, "Text")]), 0),
               ("Content-Type", text("application/json"), 0),
               ("Prefer", text("return=minimal"), 0),
           ]),
           WFJSONValues=fields([
               ("size", text(OBJ, [output(size_id, "Provided Input")]), 0),
               ("condition", text(OBJ, [output(condition_id, "Chosen Item")]), 0),
               ("flaws", text(OBJ, [output(flaws_id, "Provided Input")]), 0),
               ("photo_paths", text(OBJ, [var("Photo Paths")]), 2),
               ("status", text("new"), 0),
           ])),
    action("notification", WFNotificationActionTitle="Sell with Grok",
           WFNotificationActionBody="Sent to Grok. It picks this up within 5 minutes."),
]

workflow = {
    "WFWorkflowName": "Sell with Grok",
    "WFWorkflowClientVersion": "2605.0.5",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 61440},
    "WFWorkflowTypes": ["ActionExtension", "NCWidget"],
    "WFWorkflowInputContentItemClasses": ["WFImageContentItem"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowOutputContentItemClasses": [],
    "WFQuickActionSurfaces": [],
    "WFWorkflowActions": actions,
    "WFWorkflowImportQuestions": [
        {"ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText", "DefaultValue": "",
         "Text": "Supabase project URL (for example https://abc.supabase.co, without a trailing slash)"},
        {"ActionIndex": 1, "Category": "Parameter", "ParameterKey": "WFTextActionText", "DefaultValue": "",
         "Text": "Supabase anon key"},
    ],
}

with OUT.open("wb") as file:
    plistlib.dump(workflow, file, fmt=plistlib.FMT_BINARY)
print(f"wrote {OUT}")
