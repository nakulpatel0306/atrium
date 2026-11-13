import Foundation

var passed = 0
var failed = 0

func check(_ ok: Bool, _ name: String) {
  if ok {
    passed += 1
  } else {
    failed += 1
    print("FAIL: \(name)")
  }
}

// args
let a = parseArgs(["mail.messages", "--account", "acct-1", "--since", "2026-11-01T00:00:00Z"])
check(a?.command == "mail.messages" && a?.flags["account"] == "acct-1" && a?.flags["since"] == "2026-11-01T00:00:00Z", "args: flags")
check(parseArgs(["allow", "calendar"])?.positional == ["calendar"], "args: positional")
check(parseArgs(["mail.messages", "--account"]) == nil, "args: a flag without a value is refused")
check(parseArgs([]) == nil, "args: no command")

// headers
let raw = "Message-ID: <a@example.com>\r\nReferences: <root@example.com>\r\n <mid@example.com>\r\nTo: Sam <sam@example.com>,\r\n\tKit <kit@example.org>\r\nSubject: Re: Lease\r\nSubject: second\r\n\r\nBody: not a header"
let h = parseHeaders(raw)
check(h["message-id"] == "<a@example.com>", "headers: message id")
check(h["references"] == "<root@example.com> <mid@example.com>", "headers: folded references")
check(h["to"] == "Sam <sam@example.com>, Kit <kit@example.org>", "headers: folded to")
check(h["subject"] == "Re: Lease", "headers: first of a repeated header wins")
check(h["body"] == nil, "headers: stop at the blank line")

// ids
let id = encodeMessageId(account: "acct-1", mailbox: "Sent Messages", id: "42")
let back = decodeMessageId(id)
check(back?.account == "acct-1" && back?.mailbox == "Sent Messages" && back?.id == "42", "ids: round trip")
check(decodeMessageId("not base64!") == nil, "ids: junk is refused")

// names
check(safeName("../../etc/passwd") == "passwd", "names: no climbing")
check(safeName("..") == "attachment", "names: dots only")
check(safeName("a:b\u{0007}.pdf") == "ab.pdf", "names: no colons or control characters")
check(safeName("invoice\u{202E}fdp.app") == "invoicefdp.app", "names: no bidi override")
check(safeName("re\u{200B}port\u{2066}.pdf") == "report.pdf", "names: no zero-width or isolate characters")

// output
check(errorJSON(PimError(kind: "bad_args", message: "x")) == "{\"error\":{\"kind\":\"bad_args\",\"message\":\"x\"}}", "json: error shape")
check(hexColor(1, 0.5, 0) == "#ff8000", "json: colour")
check(mailto(URL(string: "mailto:Sam@Example.com")) == "sam@example.com", "json: mailto")
check(mailto(URL(string: "https://example.com")) == nil, "json: not mailto")

// newest first
let listed: [(box: String, id: String, date: Int)] = [("INBOX", "1", 5), ("INBOX", "2", 9), ("Inbox", "3", 7), ("INBOX", "4", 9)]
check(newestFirst(listed, limit: 3).map(\.id) == ["2", "4", "3"], "newest: sorted by date, ties in listed order, cut to the limit")
check(newestFirst(listed, limit: 0).isEmpty, "newest: a zero limit keeps none")

// writes
check(parseInput(Data("{\"account\":\"a\"}".utf8))?["account"] as? String == "a", "input: an object")
check(parseInput(Data("[1]".utf8)) == nil, "input: not an object")
let people = peopleLists([["name": "Robin\nVale", "address": "robin@example.net"], ["name": "No address"]])
check(people.names == ["Robin Vale"] && people.addresses == ["robin@example.net"], "people: one line names, no address dropped")
let split = splitEventId("ABC:123|2026-11-12T15:00:00Z")
check(split?.event == "ABC:123" && split?.occurrence == isoFormatter.date(from: "2026-11-12T15:00:00Z"), "event ids: id and occurrence")
check(splitEventId("ABC")?.occurrence == nil && splitEventId("") == nil, "event ids: plain id, empty refused")

print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
