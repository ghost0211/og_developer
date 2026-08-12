-- ogdeveloper 图形化调用自测脚本（openGauss）
-- 用法：在 ogdeveloper 中对这些对象右键 → 执行/调试
-- 覆盖：IN/OUT/INOUT/默认参数/函数/包/包内重载/错误场景/DBMS_OUTPUT
-- 说明：DBMS_OUTPUT 输出在「官方 JDBC 驱动」连接模式下可见；
--       原生协议模式下 openGauss 7.0-lite 会断开连接（已知限制）。

-- 参照表（不存在则创建）
create table if not exists ogdev_emp (
  id int primary key,
  name text not null,
  salary numeric(10,2) default 0
);
delete from ogdev_emp;
insert into ogdev_emp values (1, '张三', 10600.00), (2, '李四', 8500.50);

-- ============ 存储过程 ============

-- 1. 纯 IN 参数
create or replace procedure ogtest_proc_simple(p_id in int, p_name in text, p_salary in numeric) as
begin
  insert into ogdev_emp(id, name, salary) values (p_id, p_name, p_salary);
end;
/

-- 2. OUT 参数（图形化调用应返回结果行：name/salary）
create or replace procedure ogtest_proc_out(p_id in int, out p_name text, out p_salary numeric) as
begin
  select name, salary into p_name, p_salary from ogdev_emp where id = p_id;
end;
/

-- 3. INOUT 参数
create or replace procedure ogtest_proc_inout(inout p_counter int) as
begin
  p_counter := p_counter * 2 + 1;
end;
/

-- 4. 默认参数（可省略）
create or replace procedure ogtest_proc_defaults(p_a in int, p_b in int default 100) as
begin
  gms_output.put_line('a+b = ' || (p_a + p_b));
end;
/

-- 5. DBMS_OUTPUT 输出
create or replace procedure ogtest_proc_print(p_msg in text) as
begin
  gms_output.put_line('[ogtest] ' || p_msg);
  gms_output.put_line('时间: ' || to_char(now(), 'HH24:MI:SS'));
end;
/

-- 6. 运行时报错（除零）
create or replace procedure ogtest_proc_err(p_divisor in int) as
begin
  gms_output.put_line('100/' || p_divisor || ' = ' || (100 / p_divisor));
end;
/

-- 7. 循环 + 条件 + 多个输出
create or replace procedure ogtest_proc_loop(p_count in int) as
  v_total int := 0;
begin
  for i in 1..p_count loop
    if mod(i, 2) = 0 then
      v_total := v_total + i;
    end if;
  end loop;
  gms_output.put_line('偶数合计: ' || v_total);
end;
/

-- ============ 函数 ============

-- 8. 标量返回
create or replace function ogtest_func_scalar(p_id in int) returns numeric
language plpgsql as $$
declare
  v_salary numeric;
begin
  select salary into v_salary from ogdev_emp where id = p_id;
  return v_salary;
end;
$$;

-- 9. 文本拼接
create or replace function ogtest_func_text(p_name in text) returns text
language plpgsql as $$
begin
  return 'Hello, ' || p_name || '!';
end;
$$;

-- 10. 集合返回（SELECT * FROM 形式）
create or replace function ogtest_func_setof() returns setof ogdev_emp
language plpgsql as $$
begin
  return query select * from ogdev_emp order by id;
end;
$$;

-- 11. 函数带 OUT（openGauss 需要 returns record + language plpgsql + return;）
create or replace function ogtest_func_with_out(p_id in int, out p_name text, out p_salary numeric) returns record
language plpgsql as $$
begin
  select name, salary into p_name, p_salary from ogdev_emp where id = p_id;
  return;
end;
$$;

-- ============ 包 ============

-- 12. 包：常量/私有变量/重载/状态保持
drop package if exists ogtest_pkg;
create or replace package ogtest_pkg as
  constant_version constant text := '1.0.0';
  procedure add_emp(p_id int, p_name text, p_salary numeric);
  procedure add_emp(p_id int, p_name text);
  function get_salary(p_id int) return numeric;
  procedure stats(out p_emp_count int, out p_total_salary numeric);
  procedure reset_counter;
end ogtest_pkg;
/
create or replace package body ogtest_pkg as
  -- 私有变量（包级状态，会话内保持）
  v_call_count int := 0;

  procedure add_emp(p_id int, p_name text, p_salary numeric) as
  begin
    insert into ogdev_emp(id, name, salary) values (p_id, p_name, p_salary);
    v_call_count := v_call_count + 1;
  end;

  procedure add_emp(p_id int, p_name text) as
  begin
    add_emp(p_id, p_name, 0);
  end;

  function get_salary(p_id int) return numeric as
    v_salary numeric;
  begin
    v_call_count := v_call_count + 1;
    select salary into v_salary from ogdev_emp where id = p_id;
    return v_salary;
  end;

  procedure stats(out p_emp_count int, out p_total_salary numeric) as
  begin
    select count(*), coalesce(sum(salary), 0) into p_emp_count, p_total_salary from ogdev_emp;
    gms_output.put_line('包调用次数: ' || v_call_count);
  end;

  procedure reset_counter as
  begin
    v_call_count := 0;
  end;
end ogtest_pkg;
/

-- 13. 包：默认参数 + 字符串处理
drop package if exists ogtest_text_pkg;
create or replace package ogtest_text_pkg as
  function to_upper(p_in text) return text;
  function to_lower(p_in text) return text;
  function concat_all(p_a text, p_b text, p_sep text default '|') return text;
end ogtest_text_pkg;
/
create or replace package body ogtest_text_pkg as
  function to_upper(p_in text) return text as
  begin
    return upper(p_in);
  end;
  function to_lower(p_in text) return text as
  begin
    return lower(p_in);
  end;
  function concat_all(p_a text, p_b text, p_sep text default '|') return text as
  begin
    return p_a || p_sep || p_b;
  end;
end ogtest_text_pkg;
/

-- ============ 调试用（断点/单步/变量） ============

-- 14. 调试专用：带局部变量和多次写入
create or replace procedure ogtest_debug_me(p_start in int) as
  v_value int := 0;
  v_step text;
begin
  v_value := p_start;
  v_step := 'init';
  for i in 1..3 loop
    v_value := v_value + i * 10;
    v_step := 'loop_' || i;
    insert into ogdev_emp(id, name, salary) values (100 + i, 'dbg_' || i, v_value);
  end loop;
  delete from ogdev_emp where id > 100 and id < 200;
end;
/

-- ============ 验收清单 ============
-- ogtest_proc_simple(3, '王五', 5000)          → 纯 IN，插一行
-- ogtest_proc_out(1)                            → 返回结果行 name=张三 salary=10600.00
-- ogtest_proc_inout(5)                          → 返回结果行 p_counter=11
-- ogtest_proc_defaults(1)                       → 省略 p_b，输出 a+b = 101（JDBC 模式可见）
-- ogtest_proc_print('你好')                     → DBMS_OUTPUT 两行（JDBC 模式可见）
-- ogtest_proc_err(0)                            → 除零错误
-- ogtest_proc_loop(6)                           → 输出 偶数合计: 12
-- ogtest_func_scalar(1)                         → 10600.00
-- ogtest_func_text('ogdeveloper')               → Hello, ogdeveloper!
-- ogtest_func_setof()                           → 全部员工行
-- ogtest_func_with_out(2)                       → 返回结果行 p_name/p_salary
-- ogtest_pkg.add_emp(4, '赵六', 7000)           → 包内过程（可展开包子程序）
-- ogtest_pkg.add_emp(5, '孙七')                 → 重载（默认薪资 0）
-- ogtest_pkg.get_salary(4)                      → 7000
-- ogtest_pkg.stats()                            → OUT 参数 + 包内私有状态输出
-- ogtest_text_pkg.concat_all('a','b')           → a|b
-- ogtest_debug_me(1)                            → 调试：断点/单步/变量查看
