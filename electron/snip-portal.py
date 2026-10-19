#!/usr/bin/env python3
# Screenshots on Wayland (electron/snip.js runs this): Wayland doesn't let apps read the screen, so the desktop's own
# screenshot service (the xdg-desktop-portal Screenshot portal) takes the picture. GNOME and KDE ask once whether
# Box-Deckspitter may take screenshots and remember the answer. Prints one JSON line: {"uri": "file:///..."} or
# {"error": "nogi" | "noportal" | "cancelled" | "refused" | "timeout"}. Needs python3-gi, which GNOME and KDE ship.
import json
import random
import sys

try:
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
except Exception:
    print(json.dumps({'error': 'nogi'}))
    sys.exit(0)

out = {}
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
except Exception as e:
    print(json.dumps({'error': 'noportal', 'detail': str(e)}))
    sys.exit(0)

# the answer comes as a signal on a request object whose path is known up front (sender name + our token)
token = 'bds%d' % random.randrange(1 << 30)
sender = bus.get_unique_name()[1:].replace('.', '_')
request = '/org/freedesktop/portal/desktop/request/%s/%s' % (sender, token)
loop = GLib.MainLoop()


def on_response(_conn, _sender, _path, _iface, _signal, params):
    code, results = params.unpack()
    if code == 0 and results.get('uri'):
        out['uri'] = results['uri']
    else:
        out['error'] = 'cancelled' if code == 1 else 'refused'
    loop.quit()


bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request', 'Response', request, None,
                     Gio.DBusSignalFlags.NONE, on_response)
try:
    options = {'handle_token': GLib.Variant('s', token), 'interactive': GLib.Variant('b', False)}
    bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.Screenshot',
                  'Screenshot', GLib.Variant('(sa{sv})', ('', options)), GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE,
                  10000, None)
except Exception as e:
    print(json.dumps({'error': 'noportal', 'detail': str(e)}))
    sys.exit(0)


def give_up():
    out.setdefault('error', 'timeout')
    loop.quit()
    return False


# long enough to answer the "allow screenshots?" question the first time
GLib.timeout_add_seconds(90, give_up)
loop.run()
print(json.dumps(out))
