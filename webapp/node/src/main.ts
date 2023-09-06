import express, { Request, Response, NextFunction } from "express";
import partials from "express-partials";
import session from "express-session";
// TODO
import bcrypt from "bcrypt";
import util from "util";
import { ulid } from "ulid";
import mysql, { QueryError } from "mysql2/promise";
const mysqlSession = require("express-mysql-session")(session);
import { anonUserAccount } from "./const";
import { UserRow } from "./types/db";
import {
  SignupRequest,
  LoginRequest,
  AdminPlayerBanRequest,
  AddPlaylistRequest,
  UpdatePlaylistRequest,
  FavoritePlaylistRequest,
  BasicResponse,
  SinglePlaylistResponse,
  AdminPlayerBanResponse,
  GetRecentPlaylistsResponse,
  GetPlaylistsResponse,
  AddPlaylistResponse,
} from "./types/api";
import {
  getCreatedPlaylistSummariesByUserAccount,
  getFavoritedPlaylistSummariesByUserAccount,
  getPlaylistByUlid,
  getPlaylistDetailByPlaylistUlid,
  getPlaylistFavoritesByPlaylistIdAndUserAccount,
  getPopularPlaylistSummaries,
  getRecentPlaylistSummaries,
  getSongByUlid,
  getUserByAccount,
  insertPlaylistFavorite,
  insertPlaylistSong,
} from "./db";

declare module "express-session" {
  interface SessionData {
    user_account: string;
  }

  interface Store {
    getAsync(str: string): Promise<SessionData | null | undefined>;
  }
}

const sessionCookieName = "listen80_session";
const publicPath = "./public";
const dbConfig = {
  host: process.env["ISUCON_DB_HOST"] ?? "127.0.0.1",
  port: Number(process.env["ISUCON_DB_PORT"] ?? 3306),
  user: process.env["ISUCON_DB_USER"] ?? "isucon",
  password: process.env["ISUCON_DB_PASSWORD"] ?? "isucon",
  database: process.env["ISUCON_DB_NAME"] ?? "isucon_listen80",
};

const pool = mysql.createPool(dbConfig);
const sessionStore: session.Store = new mysqlSession({}, pool);

const app = express();
app.use("/assets", express.static(publicPath + "/assets"));
app.use(express.json());
app.use(
  session({
    name: sessionCookieName,
    secret: "powawa",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
  })
);
app.use(partials());
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "private");
  next();
});

app.set("view engine", "ejs");
app.set("views", "./src/views");
app.set("etag", false);

// error wrapper
function error(req: Request, res: Response, code: number, message: string) {
  console.log(`${req.method} ${req.path} ${code} error: ${message}`);
  const body: BasicResponse = {
    result: false,
    status: code,
    error: message,
  };

  if (code === 401) {
    req.session.destroy(() => {
      res.clearCookie(sessionCookieName);
      res.status(code).json(body);
    });
    return;
  }

  res.status(code).json(body);
}

async function validateSession(
  req: Request
): Promise<{ valid: boolean; user?: UserRow }> {
  if (!req.session || !req.session.user_account) {
    return {
      valid: false,
    };
  }

  // session storeの確認
  sessionStore.getAsync = util.promisify(sessionStore.get);
  const session = await sessionStore.getAsync(req.session.id);
  if (!session || session.user_account !== req.session.user_account) {
    return {
      valid: false,
    };
  }

  // BAN statusの確認
  const [[user]] = await pool.query<UserRow[]>(
    "SELECT * FROM user where `account` = ?",
    [req.session.user_account]
  );
  if (!user || user.is_ban) {
    return {
      valid: false,
    };
  }

  return {
    valid: true,
    user,
  };
}

function generatePasswordHash(password: string): string {
  const round = 4;
  return bcrypt.hashSync(password, round);
}

function comparePasswordHash(
  newPassword: string,
  passwordHash: string
): boolean {
  return bcrypt.compareSync(newPassword, passwordHash);
}

// 認証必須ページ
const authRequiredPages = [
  { path: "/mypage", view: "mypage" },
  { path: "/playlist/:ulid/edit", view: "playlist_edit" },
];
authRequiredPages.forEach((page) => {
  app.get(page.path, async (req: Request, res: Response) => {
    // check login state
    const { valid, user } = await validateSession(req);
    if (!valid || !user) {
      res.redirect("/");
      return;
    }

    res.render(page.view + ".ejs", {
      loggedIn: true,
      params: req.params,
      displayName: user.display_name,
      userAccount: user.account,
    });
  });
});

// 認証不要ページ(ログインしている場合はヘッダを変える)
const authOptionalPages = [
  { path: "/", view: "top" },
  { path: "/playlist/:ulid", view: "playlist" },
];
authOptionalPages.forEach((page) => {
  app.get(page.path, async (req: Request, res: Response) => {
    const { valid, user } = await validateSession(req);
    if (user && user.is_ban) {
      return error(req, res, 401, "failed to fetch user (no such user)");
    }

    res.render(page.view + ".ejs", {
      loggedIn: valid,
      params: req.params,
      displayName: user ? user.display_name : "",
      userAccount: user ? user.account : "",
    });
  });
});

// 認証関連ページ
const authPages = [
  { path: "/signup", view: "signup" },
  { path: "/login", view: "login" },
];
authPages.forEach((page) => {
  app.get(page.path, async (req: Request, res: Response) => {
    res.render(page.view + ".ejs", {
      loggedIn: false,
    });
  });
});

// POST /api/signup
app.post("/api/signup", async (req: Request, res: Response) => {
  const { user_account, password, display_name } = req.body as SignupRequest;

  // validation
  if (
    !user_account ||
    user_account.length < 4 ||
    191 < user_account.length ||
    user_account.match(/[^a-zA-Z0-9\-_]/) !== null
  ) {
    return error(req, res, 400, "bad user_account");
  }
  if (
    !password ||
    password.length < 8 ||
    64 < password.length ||
    password.match(/[^a-zA-Z0-9\-_]/) != null
  ) {
    return error(req, res, 400, "bad password");
  }
  if (!display_name || display_name.length < 2 || 24 < display_name.length) {
    return error(req, res, 400, "bad display_name");
  }

  // password hashを作る
  const passwordHash = generatePasswordHash(password);

  // default value
  const is_ban = false;
  const signupTimestamp = new Date();

  const db = await pool.getConnection();
  try {
    const displayName = display_name ? display_name : user_account;
    // TODO
    await db.query(
      "INSERT INTO user (`account`, `display_name`, `password_hash`, `is_ban`, `created_at`, `last_logined_at`) VALUES (?, ?, ?, ?, ?, ?)",
      [
        user_account,
        displayName,
        passwordHash,
        is_ban,
        signupTimestamp,
        signupTimestamp,
      ]
    );

    req.session.regenerate((_err) => {
      req.session.user_account = user_account;
      const body: BasicResponse = {
        result: true,
        status: 200,
      };
      res.status(body.status).json(body);
    });
  } catch (err) {
    if ((err as QueryError).code === "ER_DUP_ENTRY") {
      return error(req, res, 400, "account already exist");
    }

    console.log(err);
    error(req, res, 500, "failed to signup");
  } finally {
    db.release();
  }
});

// POST /api/login
app.post("/api/login", async (req: Request, res: Response) => {
  const { user_account, password } = req.body as LoginRequest;

  // validation
  if (
    !user_account ||
    user_account.length < 4 ||
    191 < user_account.length ||
    user_account.match(/[^a-zA-Z0-9\-_]/) !== null
  ) {
    return error(req, res, 400, "bad user_account");
  }
  if (
    !password ||
    password.length < 8 ||
    64 < password.length ||
    password.match(/[^a-zA-Z0-9\-_]/) != null
  ) {
    return error(req, res, 400, "bad password");
  }

  // password check
  const db = await pool.getConnection();
  try {
    const user = await getUserByAccount(db, user_account);
    if (!user || user.is_ban) {
      // ユーザがいないかbanされている
      return error(req, res, 401, "failed to login (no such user)");
    }

    if (!comparePasswordHash(password, user.password_hash)) {
      // wrong password
      return error(req, res, 401, "failed to login (wrong password)");
    }

    // TODO
    // 最終ログイン日時を更新
    await db.query("UPDATE user SET last_logined_at = ? WHERE account = ?", [
      new Date(),
      user.account,
    ]);

    req.session.regenerate((_err) => {
      req.session.user_account = user.account;
      const body: BasicResponse = {
        result: true,
        status: 200,
      };
      res.status(body.status).json(body);
    });
  } catch (err) {
    console.log(err);
    error(req, res, 500, "failed to login (server error)");
  } finally {
    db.release();
  }
});

// POST /api/logout
app.post("/api/logout", async (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.clearCookie(sessionCookieName);
    const body: BasicResponse = {
      result: true,
      status: 200,
    };
    res.status(body.status).json(body);
  });
});

// GET /api/recent_playlists
app.get("/api/recent_playlists", async (req: Request, res: Response) => {
  const user_account = req.session.user_account ?? anonUserAccount;

  const db = await pool.getConnection();
  try {
    const playlists = await getRecentPlaylistSummaries(db, user_account);

    const body: GetRecentPlaylistsResponse = {
      result: true,
      status: 200,
      playlists: playlists,
    };
    res.status(body.status).json(body);
  } catch (err) {
    console.log(err);
    error(req, res, 500, "internal server error");
  } finally {
    db.release();
  }
});

// GET /api/popular_playlists
app.get("/api/popular_playlists", async (req: Request, res: Response) => {
  const user_account = req.session.user_account ?? anonUserAccount;

  const db = await pool.getConnection();
  try {
    // TODO
    // トランザクションを使わないとfav数の順番が狂うことがある
    await db.beginTransaction();
    const playlists = await getPopularPlaylistSummaries(db, user_account);

    const body: GetRecentPlaylistsResponse = {
      result: true,
      status: 200,
      playlists: playlists,
    };
    res.status(body.status).json(body);
    await db.commit();
  } catch (err) {
    await db.rollback();
    console.log(err);
    error(req, res, 500, "internal server error");
  } finally {
    db.release();
  }
});

// GET /api/playlists
app.get("/api/playlists", async (req: Request, res: Response) => {
  const { valid } = await validateSession(req);
  if (!valid) {
    return error(req, res, 401, "login required");
  }
  const user_account = req.session.user_account ?? anonUserAccount;

  const db = await pool.getConnection();
  try {
    const createdPlaylists = await getCreatedPlaylistSummariesByUserAccount(
      db,
      user_account
    );
    const favoritedPlaylists = await getFavoritedPlaylistSummariesByUserAccount(
      db,
      user_account
    );

    const body: GetPlaylistsResponse = {
      result: true,
      status: 200,
      created_playlists: createdPlaylists,
      favorited_playlists: favoritedPlaylists,
    };
    res.status(body.status).json(body);
  } catch (err) {
    console.log(err);
    error(req, res, 500, "internal server error");
  } finally {
    db.release();
  }
});

// GET /api/playlist/{:playlistUlid}
app.get("/api/playlist/:playlistUlid", async (req: Request, res: Response) => {
  // ログインは不要
  const userAccount: string = req.session.user_account || anonUserAccount;
  const playlistUlid: string = req.params.playlistUlid;

  // validation
  if (!playlistUlid || playlistUlid.match(/[^a-zA-Z0-9]/) !== null) {
    return error(req, res, 400, "bad playlist ulid");
  }

  const db = await pool.getConnection();
  try {
    const playlist = await getPlaylistByUlid(db, playlistUlid);
    if (!playlist) {
      return error(req, res, 404, "playlist not found");
    }

    // 作成者が自分ではない、privateなプレイリストは見れない
    if (playlist.user_account != userAccount && !playlist.is_public) {
      return error(req, res, 404, "playlist not found");
    }

    const playlistDetails = await getPlaylistDetailByPlaylistUlid(
      db,
      playlist.ulid,
      userAccount
    );
    if (!playlistDetails) {
      return error(req, res, 404, "playlist not found");
    }

    const body: SinglePlaylistResponse = {
      result: true,
      status: 200,
      playlist: playlistDetails,
    };
    res.status(body.status).json(body);
  } catch (err) {
    console.log(err);
    error(req, res, 500, "internal server error");
  } finally {
    db.release();
  }
});

// POST /api/playlist/add
app.post("/api/playlist/add", async (req: Request, res: Response) => {
  const { valid } = await validateSession(req);
  if (!valid) {
    return error(req, res, 401, "login required");
  }

  const { name } = req.body as AddPlaylistRequest;
  // validation
  if (!name || name.length < 2 || 191 < name.length) {
    return error(req, res, 400, "invalid name");
  }

  const userAccount = req.session.user_account ?? anonUserAccount;
  const createdTimestamp = new Date();
  const playlist_ulid = ulid(createdTimestamp.getTime());

  const db = await pool.getConnection();
  try {
    // TODO
    await db.query(
      "INSERT INTO playlist (`ulid`, `name`, `user_account`, `is_public`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?)",
      [
        playlist_ulid,
        name,
        userAccount,
        false,
        createdTimestamp,
        createdTimestamp,
      ] // 作成時は非公開
    );

    const body: AddPlaylistResponse = {
      result: true,
      status: 200,
      playlist_ulid: playlist_ulid,
    };
    res.status(body.status).json(body);
  } catch (err) {
    console.log(err);
    error(req, res, 500, "internal server error");
  } finally {
    db.release();
  }
});

// POST /api/playlist/update
app.post(
  "/api/playlist/:playlistUlid/update",
  async (req: Request, res: Response) => {
    const { valid } = await validateSession(req);
    if (!valid) {
      return error(req, res, 401, "login required");
    }
    const userAccount = req.session.user_account;

    const db = await pool.getConnection();
    try {
      const playlistUlid: string = req.params.playlistUlid;
      const playlist = await getPlaylistByUlid(db, playlistUlid);
      if (!playlist) {
        return error(req, res, 404, "playlist not found");
      }
      if (playlist.user_account != userAccount) {
        // 権限エラーだが、URI上のパラメータが不正なので404を返す
        return error(req, res, 404, "playlist not found");
      }

      const { name, song_ulids, is_public } = req.body as UpdatePlaylistRequest;
      // validation
      if (!playlistUlid || playlistUlid.match(/[^a-zA-Z0-9]/) !== null) {
        return error(req, res, 404, "bad playlist ulid");
      }
      // 3つの必須パラメータをチェック
      if (!name || !song_ulids || is_public === undefined) {
        return error(
          req,
          res,
          400,
          "name, song_ulids and is_public is required"
        );
      }
      // nameは2文字以上191文字以内
      if (name.length < 2 || 191 < name.length) {
        return error(req, res, 400, "invalid name");
      }
      // 曲数は最大80曲
      if (80 < song_ulids.length) {
        return error(req, res, 400, "invalid song_ulids");
      }
      // 曲は重複してはいけない
      const songUlidsSet = new Set(song_ulids);
      if (songUlidsSet.size != song_ulids.length) {
        return error(req, res, 400, "invalid song_ulids");
      }

      const updatedTimestamp = new Date();

      // TODO
      await db.beginTransaction();

      // name, is_publicの更新
      await db.query(
        "UPDATE playlist SET name = ?, is_public = ?, `updated_at` = ? WHERE `ulid` = ?",
        [name, is_public, updatedTimestamp, playlist.ulid]
      );

      // songsを削除→新しいものを入れる
      await db.query("DELETE FROM playlist_song WHERE playlist_id = ?", [
        playlist.id,
      ]);

      for (const [index, songUlid] of song_ulids.entries()) {
        const song = await getSongByUlid(db, songUlid);
        if (!song) {
          await db.rollback();
          return error(req, res, 400, `song not found. ulid: ${songUlid}`);
        }

        // songSortOrderは 0 based、保存するsort_orderは 1 based なので+1
        await insertPlaylistSong(db, {
          playlistId: playlist.id,
          sortOrder: index + 1,
          songId: song.id,
        });
      }

      await db.commit();

      const playlistDetails = await getPlaylistDetailByPlaylistUlid(
        db,
        playlist.ulid,
        userAccount
      );
      if (!playlistDetails) {
        return error(
          req,
          res,
          500,
          "error occurred: getPlaylistDetailByPlaylistUlid"
        );
      }

      const body: SinglePlaylistResponse = {
        result: true,
        status: 200,
        playlist: playlistDetails,
      };
      res.status(body.status).json(body);
    } catch (err) {
      await db.rollback();
      console.log(err);
      error(req, res, 500, "internal server error");
    } finally {
      db.release();
    }
  }
);

// POST /api/playlist/delete
app.post(
  "/api/playlist/:playlistUlid/delete",
  async (req: Request, res: Response) => {
    const { valid } = await validateSession(req);
    if (!valid) {
      return error(req, res, 401, "login required");
    }
    const playlistUlid: string = req.params.playlistUlid;
    // validation
    if (!playlistUlid || playlistUlid.match(/[^a-zA-Z0-9]/) !== null) {
      return error(req, res, 404, "bad playlist ulid");
    }

    const db = await pool.getConnection();
    try {
      const playlist = await getPlaylistByUlid(db, playlistUlid);
      if (!playlist) {
        return error(req, res, 400, "playlist not found");
      }

      if (playlist.user_account !== req.session.user_account) {
        return error(req, res, 400, "do not delete other users playlist");
      }

      // TODO
      await db.query("DELETE FROM playlist WHERE `ulid` = ?", [playlist.ulid]);
      await db.query("DELETE FROM playlist_song WHERE playlist_id = ?", [
        playlist.id,
      ]);
      await db.query("DELETE FROM playlist_favorite WHERE playlist_id = ?", [
        playlist.id,
      ]);

      const body: BasicResponse = {
        result: true,
        status: 200,
      };
      res.status(200).json(body);
    } catch (err) {
      console.log(err);
      error(req, res, 500, "internal server error");
    } finally {
      db.release();
    }
  }
);

// POST /api/playlist/:ulid/favorite
app.post(
  "/api/playlist/:playlistUlid/favorite",
  async (req: Request, res: Response) => {
    const { valid, user } = await validateSession(req);
    if (!valid || !user || !req.session.user_account) {
      return error(req, res, 401, "login required");
    }
    const playlistUlid: string = req.params.playlistUlid;
    const { is_favorited } = req.body as FavoritePlaylistRequest;
    if (!playlistUlid || playlistUlid.match(/[^a-zA-Z0-9]/) !== null) {
      return error(req, res, 404, "bad playlist ulid");
    }

    const db = await pool.getConnection();
    try {
      const playlist = await getPlaylistByUlid(db, playlistUlid);
      if (!playlist) {
        return error(req, res, 404, "playlist not found");
      }
      // 操作対象のプレイリストが他のユーザーの場合、banされているかプレイリストがprivateならばnot found
      if (playlist.user_account !== user.account) {
        if (!user || user.is_ban || !playlist.is_public) {
          return error(req, res, 404, "playlist not found");
        }
      }

      if (is_favorited) {
        // insert
        const createdTimestamp = new Date();
        const playlistFavorite =
          await getPlaylistFavoritesByPlaylistIdAndUserAccount(
            db,
            playlist.id,
            req.session.user_account
          );
        if (!playlistFavorite) {
          await insertPlaylistFavorite(db, {
            playlistId: playlist.id,
            favoriteUserAccount: req.session.user_account,
            createdAt: createdTimestamp,
          });
        }
      } else {
        // TODO
        // delete
        await db.query(
          "DELETE FROM playlist_favorite WHERE `playlist_id` = ? AND `favorite_user_account` = ?",
          [playlist.id, req.session.user_account]
        );
      }

      const playlistDetail = await getPlaylistDetailByPlaylistUlid(
        db,
        playlist.ulid,
        req.session.user_account
      );
      if (!playlistDetail) {
        return error(req, res, 404, "failed to fetch playlist detail");
      }

      const body: SinglePlaylistResponse = {
        result: true,
        status: 200,
        playlist: playlistDetail,
      };
      res.status(body.status).json(body);
    } catch (err) {
      console.log(err);
      error(req, res, 500, "internal server error");
    } finally {
      db.release();
    }
  }
);

// POST /api/admin/user/ban
app.post("/api/admin/user/ban", async (req: Request, res: Response) => {
  const { valid, user } = await validateSession(req);
  if (!valid || !user) {
    return error(req, res, 401, "login required");
  }

  // 管理者userであることを確認,でなければ403
  if (!isAdminUser(user.account)) {
    return error(req, res, 403, "not admin user");
  }

  const { user_account, is_ban } = req.body as AdminPlayerBanRequest;

  const db = await pool.getConnection();
  try {
    await db.query("UPDATE user SET `is_ban` = ?  WHERE `account` = ?", [
      is_ban,
      user_account,
    ]);
    const user = await getUserByAccount(db, user_account);
    if (!user) {
      return error(req, res, 400, "user not found");
    }

    const body: AdminPlayerBanResponse = {
      result: true,
      status: 200,
      user_account: user.account,
      display_name: user.display_name,
      is_ban: !!user.is_ban,
      created_at: user.created_at,
    };
    res.status(body.status).json(body);
  } catch (err) {
    console.log(err);
    error(req, res, 500, "internal server error");
  } finally {
    db.release();
  }
});

function isAdminUser(account: string): boolean {
  // ひとまず一人決め打ち、後に条件増やすかも
  if (account === "adminuser") {
    return true;
  }
  return false;
}

// 競技に必要なAPI
// DBの初期化処理
const lastCreatedAt: string = "2022-05-13 09:00:00.000";

app.post("/initialize", async (req: Request, res: Response) => {
  const db = await pool.getConnection();
  try {
    await db.query("DELETE FROM user WHERE ? < created_at", [lastCreatedAt]);
    await db.query(
      "DELETE FROM playlist WHERE ? < created_at OR user_account NOT IN (SELECT account FROM user)",
      [lastCreatedAt]
    );
    await db.query(
      "DELETE FROM playlist_song WHERE playlist_id NOT IN (SELECT id FROM playlist)"
    );
    await db.query(
      "DELETE FROM playlist_favorite WHERE playlist_id NOT IN (SELECT id FROM playlist) OR ? < created_at",
      [lastCreatedAt]
    );
    const body: BasicResponse = {
      result: true,
      status: 200,
    };
    res.status(body.status).json(body);
  } catch {
    error(req, res, 500, "internal server error");
  }
});

const port = parseInt(process.env["SERVER_APP_PORT"] ?? "3000", 10);
console.log("starting listen80 server on :" + port + " ...");
app.listen(port);
