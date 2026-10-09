# Stash Shuffle Autoplay

A small UI plugin for [Stash](https://github.com/stashapp/stash) that adds a shuffle button to the navigation bar. It picks a random scene and builds a queue of up to 20 scenes for autoplay.

The queue favors scenes sharing performers, tags, or a studio with the first scene. On a performer, studio, or tag page, the initial scene is chosen from that page. A floating panel shows the queue and provides skip and stop controls.

## Install

1. Copy `shuffle.yml`, `shuffle.js`, and `shuffle.css` into Stash's `plugins` directory. By default this is the `plugins` subdirectory beside Stash's `config.yml`.
2. In Stash, open **Settings → Plugins** and select **Reload Plugins**.
3. Refresh the browser page. The shuffle button should appear in the navigation bar.

The plugin uses Stash's GraphQL API and native scene queue URL parameters. It does not need a separate server process.

## Current verification

The plugin was loaded and enabled on Stash v0.31.1. Its JavaScript and CSS endpoints were served successfully, and its scene queries were checked against a live library. A full browser autoplay transition has not yet been verified on that server.
