// Operaciones de biblioteca compartidas por la API y la importación.

export function albumFromRow(row) {
  if (!row) return null;
  const album = {
    id: row.id,
    title: row.title,
    artist: row.artist,
    artistId: row.artist_id,
    year: row.year,
    releaseDate: row.release_date,
    genre: row.genre,
    trackCount: row.track_count,
    artworkUrl: row.artwork_url,
    appleUrl: row.apple_url,
    provider: row.provider || 'apple',
    externalUrl: row.external_url ?? null,
    bandcampUrl: row.bandcamp_url ?? null,
    bandcampId: row.bandcamp_id ?? null,
    explicit: Boolean(row.explicit),
    savedAt: row.created_at,
  };
  if (row.position !== undefined) {
    album.position = row.position;
    album.originalPosition = row.original_position;
    album.addedAt = row.added_at;
  }
  if (row.collection_count !== undefined) album.collectionCount = row.collection_count;
  return album;
}

export function createLibrary(db) {
  const q = {
    album: db.prepare('SELECT * FROM albums WHERE id = ?'),
    upsertAlbum: db.prepare(`
      INSERT INTO albums (id, title, artist, artist_id, year, release_date, genre, track_count,
                          artwork_url, apple_url, explicit, copyright, country, provider, external_url,
                          bandcamp_url, bandcamp_id)
      VALUES (:id, :title, :artist, :artistId, :year, :releaseDate, :genre, :trackCount,
              :artworkUrl, :appleUrl, :explicit, :copyright, :country, :provider, :externalUrl,
              :bandcampUrl, :bandcampId)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, artist = excluded.artist, artist_id = excluded.artist_id,
        year = excluded.year, release_date = excluded.release_date, genre = excluded.genre,
        track_count = excluded.track_count, artwork_url = excluded.artwork_url,
        apple_url = excluded.apple_url, explicit = excluded.explicit,
        copyright = excluded.copyright, country = excluded.country,
        provider = excluded.provider, external_url = excluded.external_url,
        -- la copia de Bandcamp ya asociada se respeta (solo se cambia con setBandcamp)
        bandcamp_url = COALESCE(albums.bandcamp_url, excluded.bandcamp_url),
        bandcamp_id = CASE WHEN albums.bandcamp_url IS NULL OR albums.bandcamp_url = excluded.bandcamp_url
                           THEN COALESCE(albums.bandcamp_id, excluded.bandcamp_id) ELSE albums.bandcamp_id END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`),
    maxPosition: db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM collection_albums WHERE collection_id = ?'),
    addToCollection: db.prepare(`
      INSERT OR IGNORE INTO collection_albums (collection_id, album_id, position, original_position)
      VALUES (?, ?, ?, ?)`),
    removeFromCollection: db.prepare('DELETE FROM collection_albums WHERE collection_id = ? AND album_id = ?'),
    touchCollection: db.prepare("UPDATE collections SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"),
    setBandcamp: db.prepare('UPDATE albums SET bandcamp_url = ?, bandcamp_id = ? WHERE id = ?'),
    linkBandcampIfEmpty: db.prepare('UPDATE albums SET bandcamp_url = ? WHERE id = ? AND bandcamp_url IS NULL'),
  };

  function saveAlbum(album) {
    q.upsertAlbum.run({
      id: album.id,
      title: album.title,
      artist: album.artist,
      artistId: album.artistId ?? null,
      year: album.year ?? null,
      releaseDate: album.releaseDate ?? null,
      genre: album.genre ?? null,
      trackCount: album.trackCount ?? null,
      artworkUrl: album.artworkUrl ?? null,
      appleUrl: album.appleUrl ?? null,
      explicit: album.explicit ? 1 : 0,
      copyright: album.copyright ?? null,
      country: album.country ?? null,
      provider: album.provider === 'bandcamp' ? 'bandcamp' : 'apple',
      externalUrl: album.externalUrl ?? null,
      bandcampUrl: album.bandcampUrl ?? (album.provider === 'bandcamp' ? album.externalUrl ?? null : null),
      bandcampId: album.bandcampId ?? null,
    });
  }

  // Copia de Bandcamp asociada a un disco (de Apple Music o no).
  const setBandcamp = (albumId, url, bandcampId = null) => q.setBandcamp.run(url, bandcampId, albumId);
  const linkBandcampIfEmpty = (albumId, url) => q.linkBandcampIfEmpty.run(url, albumId);

  const getAlbum = (id) => albumFromRow(q.album.get(id));

  // Sin posición explícita, el álbum se añade al final.
  function addAlbumToCollection(collectionId, albumId, { position, originalPosition = null } = {}) {
    const pos = position ?? q.maxPosition.get(collectionId).m + 1;
    const r = q.addToCollection.run(collectionId, albumId, pos, originalPosition);
    if (r.changes) q.touchCollection.run(collectionId);
    return r.changes > 0;
  }

  function removeAlbumFromCollection(collectionId, albumId) {
    q.removeFromCollection.run(collectionId, albumId);
    q.touchCollection.run(collectionId);
  }

  return { saveAlbum, getAlbum, addAlbumToCollection, removeAlbumFromCollection, setBandcamp, linkBandcampIfEmpty };
}
