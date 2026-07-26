"""WinFsp callbacks for the iPhone AFC-backed filesystem."""

from iphone_mount_base import *


class IPhoneFileSystemOperations(MountOperationsBase):
    def get_volume_info(self):
        with self._lock:
            try:
                info = self.bridge.afc.get_device_info()
                total = int(info.get("FSTotalBytes", 0) or 0)
                free = int(info.get("FSFreeBytes", 0) or 0)
            except Exception:
                total = free = 0
            return {"total_size": total, "free_size": free, "volume_label": "iDrivePulse iPhone"}

    def set_volume_label(self, volume_label):
        raise NTStatusMediaWriteProtected()

    def get_security_by_name(self, file_name):
        with self._lock:
            context = self._context_from_stat(windows_to_afc_path(file_name))
            return self._attributes(context.is_dir), self._security.handle, self._security.size

    def get_security(self, file_context):
        return self._security

    def set_security(self, file_context, security_information, modification_descriptor):
        raise NTStatusMediaWriteProtected()

    def open(self, file_name, create_options, granted_access):
        with self._lock:
            return self._context_from_stat(windows_to_afc_path(file_name))

    def create(
        self,
        file_name,
        create_options,
        granted_access,
        file_attributes,
        security_descriptor,
        allocation_size,
    ):
        with self._lock:
            path = self._assert_writable(windows_to_afc_path(file_name), allow_root=False)
            parent = normalize_afc_path(os.path.dirname(path).replace("\\", "/"))
            try:
                parent_context = self._context_from_stat(parent)
            except NTStatusObjectNameNotFound:
                raise NTStatusObjectNameNotFound()
            if not parent_context.is_dir:
                raise NTStatusNotADirectory()
            if self.bridge.afc.exists(path) or path in self._pending:
                raise NTStatusObjectNameCollision()

            if create_options & CREATE_FILE_CREATE_OPTIONS.FILE_DIRECTORY_FILE:
                self.bridge.afc.makedirs(path)
                return self._context_from_stat(path)

            handle, local_path = tempfile.mkstemp(prefix="mount-write-", dir=self.cache_dir)
            os.close(handle)
            if allocation_size:
                with open(local_path, "r+b") as output:
                    output.truncate(allocation_size)
            context = AFCFileContext(path, False, 0, filetime_now(), local_path=local_path, dirty=True)
            self._pending[path] = context
            return context

    def overwrite(self, file_context, file_attributes, replace_file_attributes, allocation_size):
        if not file_context.local_path:
            raise NTStatusMediaWriteProtected()
        with open(file_context.local_path, "r+b") as output:
            output.truncate(allocation_size)
        file_context.size = allocation_size
        file_context.dirty = True

    def close(self, file_context):
        with self._lock:
            if file_context.afc_handle is not None:
                try:
                    self.bridge.afc.fclose(file_context.afc_handle)
                finally:
                    file_context.afc_handle = None
            if file_context.dirty:
                self._commit(file_context)
            if file_context.local_path:
                try:
                    os.remove(file_context.local_path)
                except FileNotFoundError:
                    pass
                file_context.local_path = None

    def get_file_info(self, file_context):
        with self._lock:
            return self._file_info(file_context)

    def get_dir_info_by_name(self, file_context, file_name):
        if not file_context.is_dir:
            raise NTStatusNotADirectory()
        path = normalize_afc_path(f"{file_context.path}/{file_name}")
        child = self._context_from_stat(path)
        return {"file_name": file_name, **self._file_info(child)}

    def read_directory(self, file_context, marker):
        with self._lock:
            if not file_context.is_dir:
                raise NTStatusNotADirectory()
            self._refresh_virtual_library()
            if file_context.virtual:
                names = self._virtual_children(file_context.path)
            else:
                try:
                    names = set(self.bridge.afc.listdir(file_context.path))
                except Exception:
                    raise NTStatusAccessDenied()
                if file_context.path == "/":
                    names.add(VIRTUAL_LIBRARY_ROOT.strip("/"))
            for pending_path in self._pending:
                if normalize_afc_path(os.path.dirname(pending_path)) == file_context.path:
                    names.add(pending_path.rsplit("/", 1)[-1])
            names.discard(".")
            names.discard("..")
            entries = []
            if file_context.path != "/":
                entries.append({"file_name": ".", **self._file_info(file_context)})
                parent = self._context_from_stat(normalize_afc_path(os.path.dirname(file_context.path)))
                entries.append({"file_name": "..", **self._file_info(parent)})
            for name in sorted(names, key=str.casefold):
                try:
                    child = self._context_from_stat(normalize_afc_path(f"{file_context.path}/{name}"))
                    entries.append({"file_name": name, **self._file_info(child)})
                except NTStatusObjectNameNotFound:
                    continue
            if marker is None:
                return entries
            for index, entry in enumerate(entries):
                if entry["file_name"] == marker:
                    return entries[index + 1 :]
            return entries

    def read(self, file_context, offset, length):
        with self._lock:
            if file_context.is_dir:
                raise NTStatusAccessDenied()
            if offset >= file_context.size:
                raise NTStatusEndOfFile()
            if file_context.local_path:
                with open(file_context.local_path, "rb") as source:
                    source.seek(offset)
                    return source.read(length)
            remote_path = file_context.remote_path or file_context.path

            def fetch(block_offset, block_length):
                if file_context.afc_handle is None:
                    file_context.afc_handle = self.bridge.afc.fopen(remote_path, "r")
                seek = getattr(self.bridge.afc, "fseek", None)
                if not callable(seek):
                    raise NTStatusAccessDenied()
                seek(file_context.afc_handle, block_offset, 0)
                return self.bridge.afc.fread(file_context.afc_handle, block_length)

            return self.range_cache.read(remote_path, file_context.size, offset, length, fetch)

    def write(self, file_context, buffer, offset, write_to_end_of_file, constrained_io):
        with self._lock:
            if not file_context.local_path:
                raise NTStatusMediaWriteProtected()
            if write_to_end_of_file:
                offset = os.path.getsize(file_context.local_path)
            if constrained_io and offset >= file_context.size:
                return 0
            data = bytes(buffer)
            if constrained_io:
                data = data[: max(0, file_context.size - offset)]
            with open(file_context.local_path, "r+b") as output:
                output.seek(offset)
                output.write(data)
                output.flush()
            file_context.size = max(file_context.size, offset + len(data))
            file_context.dirty = True
            return len(data)

    def flush(self, file_context):
        return None

    def set_file_size(self, file_context, new_size, set_allocation_size):
        with self._lock:
            if not file_context.local_path:
                raise NTStatusMediaWriteProtected()
            with open(file_context.local_path, "r+b") as output:
                output.truncate(new_size)
            file_context.size = new_size
            file_context.dirty = True

    def set_basic_info(
        self,
        file_context,
        file_attributes,
        creation_time,
        last_access_time,
        last_write_time,
        change_time,
        file_info,
    ):
        self._assert_writable(file_context.path)
        if last_write_time:
            file_context.mtime = last_write_time
        return self._file_info(file_context)

    def can_delete(self, file_context, file_name):
        with self._lock:
            path = self._assert_writable(windows_to_afc_path(file_name), allow_root=False)
            if file_context.is_dir:
                children = [name for name in self.bridge.afc.listdir(path) if name not in (".", "..")]
                if children:
                    raise NTStatusDirectoryNotEmpty()

    def cleanup(self, file_context, file_name, flags):
        with self._lock:
            if flags & FSP_CLEANUP_DELETE:
                path = self._assert_writable(windows_to_afc_path(file_name), allow_root=False)
                if path in self._pending:
                    self._pending.pop(path, None)
                elif self.bridge.afc.exists(path):
                    self.bridge.afc.rm(path)
                file_context.deleted = True
                file_context.dirty = False
                return
            if file_context.dirty:
                self._commit(file_context)

    def rename(self, file_context, file_name, new_file_name, replace_if_exists):
        with self._lock:
            old_path = self._assert_writable(windows_to_afc_path(file_name), allow_root=False)
            new_path = self._assert_writable(windows_to_afc_path(new_file_name), allow_root=False)
            if self.bridge.afc.exists(new_path) and not replace_if_exists:
                raise NTStatusObjectNameCollision()
            if old_path in self._pending:
                context = self._pending.pop(old_path)
                context.path = new_path
                self._pending[new_path] = context
            else:
                self.bridge.afc.rename(old_path, new_path)
            file_context.path = new_path
