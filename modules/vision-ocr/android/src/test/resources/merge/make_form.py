# Test fixture generator (pypdf): python3 make_form.py form-a.pdf
# form-b.pdf is the same form with other values: name=Bob, choice=A (the
# first button), a.b=other, c=two.
# Builds form.pdf: a text field "name", a radio group "choice" (parent with
# two widget kids, no /T on the kids), a hierarchical field "a.b" (/T "a" on
# the parent, "b" on the terminal, widget merged with it), and a field "c"
# with two widget kids (one field, two widgets), and a check box "agree".
import sys
from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, DictionaryObject, NameObject, NumberObject,
                           TextStringObject, StreamObject, FloatObject, BooleanObject)

w = PdfWriter()
page = w.add_blank_page(612, 792)

def stream(content):
    s = StreamObject()
    s.set_data(content.encode())
    s.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
              NameObject('/BBox'): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(20), FloatObject(20)])})
    return w._add_object(s)

def rect(x, y, ww=150, hh=20):
    return ArrayObject([FloatObject(x), FloatObject(y), FloatObject(x + ww), FloatObject(y + hh)])

annots = ArrayObject()
fields = ArrayObject()
pref = page.indirect_reference

def widget(extra):
    d = DictionaryObject({NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Widget'),
                          NameObject('/P'): pref, NameObject('/F'): NumberObject(4)})
    d.update(extra)
    return d

# name
name = w._add_object(widget({NameObject('/T'): TextStringObject('name'), NameObject('/FT'): NameObject('/Tx'),
                             NameObject('/V'): TextStringObject('Alice'), NameObject('/Rect'): rect(50, 700)}))
annots.append(name); fields.append(name)

# radio group "choice"
on_a, off = stream('0 0 1 rg 5 5 10 10 re f'), stream('')
radio = w._add_object(DictionaryObject({NameObject('/T'): TextStringObject('choice'), NameObject('/FT'): NameObject('/Btn'),
                                         NameObject('/Ff'): NumberObject(49152), NameObject('/V'): NameObject('/B'),
                                         NameObject('/Kids'): ArrayObject()}))
for i, state in enumerate(['/A', '/B']):
    kid = w._add_object(widget({NameObject('/Parent'): radio, NameObject('/Rect'): rect(50 + 30 * i, 650, 20, 20),
                                NameObject('/AS'): NameObject(state if state == '/B' else '/Off'),
                                NameObject('/AP'): DictionaryObject({NameObject('/N'): DictionaryObject({
                                    NameObject(state): stream('0 0 1 rg 5 5 10 10 re f'), NameObject('/Off'): off})})}))
    radio.get_object()['/Kids'].append(kid); annots.append(kid)
fields.append(radio)

# hierarchical a.b
a = w._add_object(DictionaryObject({NameObject('/T'): TextStringObject('a'), NameObject('/Kids'): ArrayObject()}))
b = w._add_object(widget({NameObject('/T'): TextStringObject('b'), NameObject('/FT'): NameObject('/Tx'),
                          NameObject('/V'): TextStringObject('inner'), NameObject('/Parent'): a, NameObject('/Rect'): rect(50, 600)}))
a.get_object()['/Kids'].append(b); annots.append(b); fields.append(a)

# c: one field, two widgets
c = w._add_object(DictionaryObject({NameObject('/T'): TextStringObject('c'), NameObject('/FT'): NameObject('/Tx'),
                                     NameObject('/V'): TextStringObject('twice'), NameObject('/Kids'): ArrayObject()}))
for i in range(2):
    k = w._add_object(widget({NameObject('/Parent'): c, NameObject('/Rect'): rect(50, 550 - 30 * i)}))
    c.get_object()['/Kids'].append(k); annots.append(k)
fields.append(c)


# check box "agree" (checked)
agree = w._add_object(widget({NameObject('/T'): TextStringObject('agree'), NameObject('/FT'): NameObject('/Btn'),
                              NameObject('/V'): NameObject('/Yes'), NameObject('/AS'): NameObject('/Yes'), NameObject('/Rect'): rect(300, 650, 20, 20),
                              NameObject('/AP'): DictionaryObject({NameObject('/N'): DictionaryObject({
                                  NameObject('/Yes'): stream('0 0 0 rg 5 5 10 10 re f'), NameObject('/Off'): stream('')})})}))
annots.append(agree); fields.append(agree)

page[NameObject('/Annots')] = annots
def font(base):
    return w._add_object(DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                                           NameObject('/BaseFont'): NameObject(base)}))
w._root_object[NameObject('/AcroForm')] = w._add_object(DictionaryObject({NameObject('/Fields'): fields,
    NameObject('/DA'): TextStringObject('/Helv 0 Tf 0 g'),
    NameObject('/DR'): DictionaryObject({NameObject('/Font'): DictionaryObject({
        NameObject('/Helv'): font('/Helvetica'), NameObject('/ZaDb'): font('/ZapfDingbats')})})}))
with open(sys.argv[1], 'wb') as f:
    w.write(f)
