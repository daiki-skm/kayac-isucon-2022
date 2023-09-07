import mysql, { RowDataPacket } from "mysql2/promise";
import { anonUserAccount } from "./const";
import {
  UserRow,
  SongRow,
  ArtistRow,
  PlaylistRow,
  PlaylistSongRow,
  PlaylistFavoriteRow,
} from "./types/db";
import { Playlist, PlaylistDetail, Song } from "./types/api";

export async function getPlaylistByUlid(
  db: mysql.Connection,
  playlistUlid: string
): Promise<PlaylistRow | undefined> {
  const [[row]] = await db.query<PlaylistRow[]>(
    "SELECT * FROM playlist WHERE `ulid` = ?",
    [playlistUlid]
  );
  return row;
}

export async function getPlaylistById(
  db: mysql.Connection,
  playlistId: number
): Promise<PlaylistRow | undefined> {
  const [[row]] = await db.query<PlaylistRow[]>(
    "SELECT * FROM playlist WHERE `id` = ?",
    [playlistId]
  );
  return row;
}

export async function getSongByUlid(
  db: mysql.Connection,
  songUlid: string
): Promise<SongRow | undefined> {
  const [[result]] = await db.query<SongRow[]>(
    "SELECT * FROM song WHERE `ulid` = ?",
    [songUlid]
  );
  return result;
}

export async function isFavoritedBy(
  db: mysql.Connection,
  userAccount: string,
  playlistId: number
): Promise<boolean> {
  const [[row]] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS cnt FROM playlist_favorite where favorite_user_account = ? AND playlist_id = ?",
    [userAccount, playlistId]
  );
  return row.cnt > 0;
}

export async function getFavoritesCountByPlaylistId(
  db: mysql.Connection,
  playlistId: number
): Promise<number> {
  const [[row]] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS cnt FROM playlist_favorite where playlist_id = ?",
    [playlistId]
  );
  return row.cnt;
}

export async function getSongsCountByPlaylistId(
  db: mysql.Connection,
  playlistId: number
): Promise<number> {
  const [[row]] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS cnt FROM playlist_song where playlist_id = ?",
    [playlistId]
  );
  return row.cnt;
}

export async function getRecentPlaylistSummaries(
  db: mysql.Connection,
  userAccount: string
): Promise<Playlist[]> {
  const [allPlaylists] = await db.query<PlaylistRow[]>(
    "SELECT * FROM playlist where is_public = ? ORDER BY created_at DESC",
    [true]
  );
  if (!allPlaylists.length) return [];

  const playlists: Playlist[] = [];
  for (const playlist of allPlaylists) {
    const user = await getUserByAccount(db, playlist.user_account);
    if (!user || user.is_ban) {
      // banされていたら除外する
      continue;
    }

    const songCount = await getSongsCountByPlaylistId(db, playlist.id);
    const favoriteCount = await getFavoritesCountByPlaylistId(db, playlist.id);

    let isFavorited: boolean = false;
    if (userAccount != anonUserAccount) {
      // 認証済みの場合はfavを取得
      isFavorited = await isFavoritedBy(db, userAccount, playlist.id);
    }

    playlists.push({
      ulid: playlist.ulid,
      name: playlist.name,
      user_display_name: user.display_name,
      user_account: user.account,
      song_count: songCount,
      favorite_count: favoriteCount,
      is_favorited: isFavorited,
      is_public: !!playlist.is_public,
      created_at: playlist.created_at,
      updated_at: playlist.updated_at,
    });
    if (playlists.length >= 100) {
      break;
    }
  }
  return playlists;
}

export async function getPopularPlaylistSummaries(
  db: mysql.Connection,
  userAccount: string
): Promise<Playlist[]> {
  const [popular] = await db.query<PlaylistFavoriteRow[]>(
    `SELECT playlist_id, count(*) AS favorite_count FROM playlist_favorite GROUP BY playlist_id ORDER BY count(*) DESC`
  );
  if (!popular.length) return [];

  const playlists: Playlist[] = [];
  for (const row of popular) {
    const playlist = await getPlaylistById(db, row.playlist_id);
    // 非公開のものは除外する
    if (!playlist || !playlist.is_public) continue;

    const user = await getUserByAccount(db, playlist.user_account);
    if (!user || user.is_ban) {
      // banされていたら除外する
      continue;
    }

    const songCount = await getSongsCountByPlaylistId(db, playlist.id);
    const favoriteCount = await getFavoritesCountByPlaylistId(db, playlist.id);

    let isFavorited: boolean = false;
    if (userAccount != anonUserAccount) {
      // 認証済みの場合はfavを取得
      isFavorited = await isFavoritedBy(db, userAccount, playlist.id);
    }

    playlists.push({
      ulid: playlist.ulid,
      name: playlist.name,
      user_display_name: user.display_name,
      user_account: user.account,
      song_count: songCount,
      favorite_count: favoriteCount,
      is_favorited: isFavorited,
      is_public: !!playlist.is_public,
      created_at: playlist.created_at,
      updated_at: playlist.updated_at,
    });
    if (playlists.length >= 100) {
      break;
    }
  }
  return playlists;
}

export async function getCreatedPlaylistSummariesByUserAccount(
  db: mysql.Connection,
  userAccount: string
): Promise<Playlist[]> {
  const [playlists] = await db.query<PlaylistRow[]>(
    "SELECT * FROM playlist where user_account = ? ORDER BY created_at DESC LIMIT 100",
    [userAccount]
  );
  if (!playlists.length) return [];

  const user = await getUserByAccount(db, userAccount);
  if (!user || user.is_ban) return [];

  return await Promise.all(
    playlists.map(async (row: PlaylistRow) => {
      const songCount = await getSongsCountByPlaylistId(db, row.id);
      const favoriteCount = await getFavoritesCountByPlaylistId(db, row.id);
      const isFavorited = await isFavoritedBy(db, userAccount, row.id);

      return {
        ulid: row.ulid,
        name: row.name,
        user_display_name: user.display_name,
        user_account: user.account,
        song_count: songCount,
        favorite_count: favoriteCount,
        is_favorited: isFavorited,
        is_public: !!row.is_public,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    })
  );
}

export async function getFavoritedPlaylistSummariesByUserAccount(
  db: mysql.Connection,
  userAccount: string
): Promise<Playlist[]> {
  const [playlistFavorites] = await db.query<PlaylistFavoriteRow[]>(
    "SELECT * FROM playlist_favorite where favorite_user_account = ? ORDER BY created_at DESC",
    [userAccount]
  );
  const playlists: Playlist[] = [];
  for (const fav of playlistFavorites) {
    const playlist = await getPlaylistById(db, fav.playlist_id);
    // 非公開は除外する
    if (!playlist || !playlist.is_public) continue;

    const user = await getUserByAccount(db, playlist.user_account);
    // 作成したユーザーがbanされていたら除外する
    if (!user || user.is_ban) continue;

    const songCount = await getSongsCountByPlaylistId(db, playlist.id);
    const favoriteCount = await getFavoritesCountByPlaylistId(db, playlist.id);
    const isFavorited = await isFavoritedBy(db, userAccount, playlist.id);

    playlists.push({
      ulid: playlist.ulid,
      name: playlist.name,
      user_display_name: user.display_name,
      user_account: user.account,
      song_count: songCount,
      favorite_count: favoriteCount,
      is_favorited: isFavorited,
      is_public: !!playlist.is_public,
      created_at: playlist.created_at,
      updated_at: playlist.updated_at,
    });
    if (playlists.length >= 100) break;
  }
  return playlists;
}

export async function getPlaylistDetailByPlaylistUlid(
  db: mysql.Connection,
  playlistUlid: string,
  viewerUserAccount: string | undefined
): Promise<PlaylistDetail | undefined> {
  const playlist = await getPlaylistByUlid(db, playlistUlid);
  if (!playlist) return;

  const user = await getUserByAccount(db, playlist.user_account);
  if (!user || user.is_ban) return;

  const favoriteCount = await getFavoritesCountByPlaylistId(db, playlist.id);
  let isFavorited: boolean = false;
  if (viewerUserAccount) {
    isFavorited = await isFavoritedBy(db, viewerUserAccount, playlist.id);
  }

  const resPlaylistSongs = await db.query<PlaylistSongRow[]>(
    "SELECT * FROM playlist_song WHERE playlist_id = ?",
    [playlist.id]
  );
  const [playlistSongRows] = resPlaylistSongs;

  const songs: Song[] = await Promise.all(
    playlistSongRows.map(async (row: PlaylistSongRow): Promise<Song> => {
      const [[song]] = await db.query<SongRow[]>(
        "SELECT * FROM song WHERE id = ?",
        [row.song_id]
      );

      const [[artist]] = await db.query<ArtistRow[]>(
        "SELECT * FROM artist WHERE id = ?",
        [song.artist_id]
      );

      return {
        ulid: song.ulid,
        title: song.title,
        artist: artist.name,
        album: song.album,
        track_number: song.track_number,
        is_public: !!song.is_public,
      };
    })
  );

  return {
    ulid: playlist.ulid,
    name: playlist.name,
    user_display_name: user.display_name,
    user_account: user.account,
    song_count: songs.length,
    favorite_count: favoriteCount,
    is_favorited: isFavorited,
    is_public: !!playlist.is_public,
    songs: songs,
    created_at: playlist.created_at,
    updated_at: playlist.updated_at,
  };
}

export async function getPlaylistFavoritesByPlaylistIdAndUserAccount(
  db: mysql.Connection,
  playlistId: number,
  favoriteUserAccount: string | undefined
): Promise<PlaylistFavoriteRow | undefined> {
  const [result] = await db.query<PlaylistFavoriteRow[]>(
    "SELECT * FROM playlist_favorite WHERE `playlist_id` = ? AND `favorite_user_account` = ?",
    [playlistId, favoriteUserAccount]
  );
  if (!result.length) return;

  return result[0];
}

export async function getUserByAccount(
  db: mysql.Connection,
  account: string
): Promise<UserRow | undefined> {
  const [result] = await db.query<UserRow[]>(
    "SELECT * FROM user WHERE `account` = ?",
    [account]
  );
  if (!result.length) return;

  return result[0];
}

export async function insertPlaylistSong(
  db: mysql.Connection,
  arg: { playlistId: number; sortOrder: number; songId: number }
) {
  await db.query(
    "INSERT INTO playlist_song (`playlist_id`, `sort_order`, `song_id`) VALUES (?, ?, ?)",
    [arg.playlistId, arg.sortOrder, arg.songId]
  );
}

export async function insertPlaylistFavorite(
  db: mysql.Connection,
  arg: { playlistId: number; favoriteUserAccount: string; createdAt: Date }
) {
  await db.query(
    "INSERT INTO playlist_favorite (`playlist_id`, `favorite_user_account`, `created_at`) VALUES (?, ?, ?)",
    [arg.playlistId, arg.favoriteUserAccount, arg.createdAt]
  );
}
