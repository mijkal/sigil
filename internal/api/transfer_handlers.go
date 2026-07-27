package api

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gorilla/mux"

	sigil "sigil.dev/sigil/pkg/sigil"
)

// maxUploadBytes caps a single upload request body.
const maxUploadBytes = 512 * 1024 * 1024 // 512 MB

// UploadFiles handles POST /hosts/{name}/files — a multipart upload that streams
// each file part into the target directory on the host. Non-file fields `dir`
// (target directory, required, sent before the files) and `overwrite` ("1") are
// read from the same multipart stream.
func (s *Server) UploadFiles(w http.ResponseWriter, r *http.Request) {
	hostName := mux.Vars(r)["name"]
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)

	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, 400, "bad_request", "expected multipart/form-data: "+err.Error())
		return
	}

	var dir string
	overwrite := false
	written := []string{}

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeError(w, 400, "upload_error", err.Error())
			return
		}

		if part.FileName() == "" {
			// Regular form field.
			buf, _ := io.ReadAll(io.LimitReader(part, 8192))
			val := strings.TrimSpace(string(buf))
			switch part.FormName() {
			case "dir":
				dir = val
			case "overwrite":
				overwrite = val == "1" || strings.EqualFold(val, "true")
			}
			part.Close()
			continue
		}

		if dir == "" {
			part.Close()
			writeError(w, 400, "upload_error", "missing 'dir' field before file parts")
			return
		}

		// path.Base on the client-supplied filename prevents path traversal.
		dest := path.Join(dir, path.Base(filepath.ToSlash(part.FileName())))
		resolved, werr := s.sessions.WriteFile(hostName, dest, part, overwrite)
		part.Close()
		if werr != nil {
			writeError(w, 500, "write_error", werr.Error())
			return
		}
		written = append(written, resolved)
	}

	writeJSON(w, 200, sigil.APIResponse{Data: map[string]interface{}{"written": written}})
}

// DownloadFile handles GET /hosts/{name}/download?path=...&disposition=inline|attachment
// streaming the raw file bytes (so binaries/images work, unlike the 512 KB text
// ReadFile). `disposition=inline` is used by the image preview.
func (s *Server) DownloadFile(w http.ResponseWriter, r *http.Request) {
	hostName := mux.Vars(r)["name"]
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, 400, "bad_request", "missing path")
		return
	}

	resolved, size, isDir, err := s.sessions.StatRemote(hostName, p)
	if err != nil {
		writeError(w, 404, "not_found", err.Error())
		return
	}
	if isDir {
		writeError(w, 400, "is_directory", "path is a directory")
		return
	}

	ct := mime.TypeByExtension(filepath.Ext(resolved))
	if ct == "" {
		ct = "application/octet-stream"
	}
	disp := "attachment"
	if r.URL.Query().Get("disposition") == "inline" {
		disp = "inline"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`%s; filename="%s"`, disp, path.Base(resolved)))

	if err := s.sessions.StreamFile(hostName, resolved, w); err != nil {
		// Headers/body may already be partially written — log only.
		s.log.Warn().Err(err).Str("host", hostName).Str("path", resolved).Msg("download stream failed")
	}
}

type relocateRequest struct {
	Src       string `json:"src"`
	Dst       string `json:"dst"`
	Overwrite bool   `json:"overwrite"`
}

// MoveFile handles POST /hosts/{name}/files/move.
func (s *Server) MoveFile(w http.ResponseWriter, r *http.Request) {
	s.relocateHandler(w, r, false)
}

// CopyFile handles POST /hosts/{name}/files/copy.
func (s *Server) CopyFile(w http.ResponseWriter, r *http.Request) {
	s.relocateHandler(w, r, true)
}

func (s *Server) relocateHandler(w http.ResponseWriter, r *http.Request, isCopy bool) {
	hostName := mux.Vars(r)["name"]
	var req relocateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "bad_request", err.Error())
		return
	}
	if req.Src == "" || req.Dst == "" {
		writeError(w, 400, "bad_request", "src and dst are required")
		return
	}
	var dst string
	var err error
	if isCopy {
		dst, err = s.sessions.CopyPath(hostName, req.Src, req.Dst, req.Overwrite)
	} else {
		dst, err = s.sessions.MovePath(hostName, req.Src, req.Dst, req.Overwrite)
	}
	if err != nil {
		writeError(w, 500, "relocate_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]interface{}{"path": dst}})
}

type transferRequest struct {
	SrcHost   string `json:"src_host"`
	SrcPath   string `json:"src_path"`
	DstHost   string `json:"dst_host"`
	DstPath   string `json:"dst_path"`
	Overwrite bool   `json:"overwrite"`
}

// Transfer handles POST /transfer — stream a file from one host to another
// through the hub.
func (s *Server) Transfer(w http.ResponseWriter, r *http.Request) {
	var req transferRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "bad_request", err.Error())
		return
	}
	if req.SrcHost == "" || req.SrcPath == "" || req.DstHost == "" || req.DstPath == "" {
		writeError(w, 400, "bad_request", "src_host, src_path, dst_host, dst_path are required")
		return
	}
	dst, err := s.sessions.TransferBetweenHosts(req.SrcHost, req.SrcPath, req.DstHost, req.DstPath, req.Overwrite)
	if err != nil {
		writeError(w, 500, "transfer_error", err.Error())
		return
	}
	writeJSON(w, 200, sigil.APIResponse{Data: map[string]interface{}{"path": dst}})
}
